import { config } from '../../config/env';
import { logger } from '../../utils/logger';

// africastalking SDK is loaded lazily because it does eager network setup on construct.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getClient(): any {
  if (_client) return _client;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AfricasTalking = require('africastalking');
    _client = AfricasTalking({
      apiKey: config.AT_API_KEY,
      username: config.AT_USERNAME,
    });
    return _client;
  } catch (err) {
    logger.error({ err }, 'africastalking SDK init failed');
    throw err;
  }
}

export interface SendSmsArgs {
  from?: string;
  to: string; // E.164
  message: string;
}

export interface SendSmsResult {
  status: 'sent' | 'failed';
  messageId?: string;
  recipients?: unknown[];
  error?: string;
}

export async function sendSms(args: SendSmsArgs): Promise<SendSmsResult> {
  try {
    const client = getClient();
    const sms = client.SMS;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: Record<string, any> = {
      to: [args.to],
      message: args.message,
    };
    if (args.from) payload.from = args.from;

    const result = await sms.send(payload);
    const recipients: unknown[] = result?.SMSMessageData?.Recipients ?? [];
    const first = (recipients[0] as { messageId?: string; status?: string } | undefined) ?? undefined;

    if (first && first.status && first.status.toLowerCase() !== 'success') {
      return {
        status: 'failed',
        error: first.status,
        recipients,
        messageId: first.messageId,
      };
    }

    logger.info(
      { messageId: first?.messageId, recipientCount: recipients.length },
      'SMS sent via AT',
    );

    return {
      status: 'sent',
      messageId: first?.messageId,
      recipients,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'sendSms failed');
    return { status: 'failed', error: message };
  }
}
