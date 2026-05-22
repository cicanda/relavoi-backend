import { config } from '../config/env';
import { logger } from '../utils/logger';
import { getDb } from '../config/database';
import { pushNotificationTotal } from '../utils/metrics';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _admin: any | null = null;
let _initialized = false;
let _enabled = false;

/**
 * Lazy-init Firebase Admin. If FIREBASE_PROJECT_ID or service account path
 * are missing, return a no-op service so callers don't have to special-case.
 */
function ensureInit(): boolean {
  if (_initialized) return _enabled;
  _initialized = true;

  if (!config.FIREBASE_PROJECT_ID || !config.FIREBASE_SERVICE_ACCOUNT_PATH) {
    logger.warn('PushNotificationService: Firebase env not set — push disabled (no-op)');
    _enabled = false;
    return false;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const admin = require('firebase-admin');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sa = require(config.FIREBASE_SERVICE_ACCOUNT_PATH);
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(sa),
        projectId: config.FIREBASE_PROJECT_ID,
      });
    }
    _admin = admin;
    _enabled = true;
    logger.info({ projectId: config.FIREBASE_PROJECT_ID }, 'Firebase Admin initialized');
    return true;
  } catch (err) {
    logger.error({ err }, 'PushNotificationService: Firebase init failed — push disabled');
    _enabled = false;
    return false;
  }
}

export interface DeviceTokenRow {
  id: string;
  tenant_id: string;
  user_phone_hash: string;
  token: string;
  platform: 'ios' | 'android';
  app_bundle_id?: string;
  is_active: boolean;
  last_refreshed_at?: Date;
}

export interface SendCallNotificationResult {
  successCount: number;
  failureCount: number;
  badTokens: string[];
}

const DEFAULT_TITLE = '{tenantName} call';
const DEFAULT_BODY = 'You have an incoming call';

interface TenantPushConfig {
  title?: string;
  body?: string;
  data?: Record<string, string>;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

export class PushNotificationService {
  async sendCallNotification(
    tenantId: string,
    customerPhoneHash: string,
    sessionId: string,
  ): Promise<SendCallNotificationResult> {
    if (!ensureInit()) {
      pushNotificationTotal.inc({ result: 'no_token' });
      return { successCount: 0, failureCount: 0, badTokens: [] };
    }

    const db = getDb();
    let tokens: DeviceTokenRow[] = [];
    let tenantName = 'Relavoi';
    let pushCfg: TenantPushConfig = {};

    try {
      tokens = await db<DeviceTokenRow>('device_tokens')
        .where({
          tenant_id: tenantId,
          user_phone_hash: customerPhoneHash,
          is_active: true,
        })
        .orderBy('last_refreshed_at', 'desc');

      const tenant = await db('tenants')
        .where({ id: tenantId })
        .first('name', 'push_config');
      if (tenant) {
        tenantName = tenant.name ?? tenantName;
        pushCfg =
          typeof tenant.push_config === 'string'
            ? (JSON.parse(tenant.push_config) as TenantPushConfig)
            : (tenant.push_config ?? {});
      }
    } catch (err) {
      logger.error({ err, tenantId }, 'PushNotificationService: db lookup failed');
    }

    if (!tokens.length) {
      pushNotificationTotal.inc({ result: 'no_token' });
      return { successCount: 0, failureCount: 0, badTokens: [] };
    }

    const title = renderTemplate(pushCfg.title ?? DEFAULT_TITLE, { tenantName });
    const body = renderTemplate(pushCfg.body ?? DEFAULT_BODY, { tenantName });

    const messaging = _admin.messaging();
    const tokenStrs = tokens.map((t) => t.token);

    let response: {
      successCount: number;
      failureCount: number;
      responses: Array<{ success: boolean; error?: { code: string; message: string } }>;
    };
    try {
      response = await messaging.sendEachForMulticast({
        tokens: tokenStrs,
        notification: { title, body },
        data: {
          ...(pushCfg.data ?? {}),
          sessionId,
          tenantId,
          type: 'incoming_call',
        },
        android: { priority: 'high' },
        apns: {
          payload: { aps: { sound: 'default', contentAvailable: true } },
        },
      });
    } catch (err) {
      logger.error({ err, tenantId, tokenCount: tokenStrs.length }, 'FCM sendEachForMulticast failed');
      pushNotificationTotal.inc({ result: 'failure' }, tokenStrs.length);
      return { successCount: 0, failureCount: tokenStrs.length, badTokens: [] };
    }

    const badTokens: string[] = [];
    response.responses.forEach((r, idx) => {
      if (r.success) return;
      const code = r.error?.code ?? '';
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-argument' ||
        code === 'messaging/invalid-registration-token'
      ) {
        badTokens.push(tokenStrs[idx]);
      }
    });

    if (badTokens.length) {
      try {
        await db('device_tokens').whereIn('token', badTokens).update({ is_active: false });
      } catch (err) {
        logger.warn({ err, count: badTokens.length }, 'PushNotificationService: deactivate failed');
      }
    }

    pushNotificationTotal.inc({ result: 'success' }, response.successCount);
    pushNotificationTotal.inc({ result: 'failure' }, response.failureCount);

    logger.info(
      {
        tenantId,
        sessionId,
        successCount: response.successCount,
        failureCount: response.failureCount,
        badTokens: badTokens.length,
      },
      'Push notification dispatched',
    );

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      badTokens,
    };
  }
}

let instance: PushNotificationService | null = null;
export function getPushService(): PushNotificationService {
  if (!instance) instance = new PushNotificationService();
  return instance;
}
