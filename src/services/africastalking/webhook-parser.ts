/**
 * Africa's Talking voice webhook parser.
 *
 * AT sends form-urlencoded POSTs for both the initial call notification AND
 * subsequent status callbacks (ringing, answered, completed). The presence/
 * absence of certain fields determines which phase we're in.
 *
 * Reference fields (commonly seen):
 *   sessionId           — AT call session id (persists across all events for the call)
 *   isActive            — "1" while the call is in progress, "0" at hangup
 *   direction           — "Inbound" | "Outbound"
 *   callerNumber        — E.164
 *   destinationNumber   — E.164 (the proxy, for inbound)
 *   dtmfDigits          — only on DTMF events
 *   recordingUrl        — only on completed call with recording
 *   durationInSeconds   — only on completion
 *   currencyCode + amount — billing on completion
 *   status              — "Success" | "Aborted" | "NoAnswer" | "Failed" | "Busy"
 *   hangupCause         — present on completed/failed
 *   callStartTime / callSessionState — varies by AT product
 */

export type VoiceEventType =
  | 'incoming_call'
  | 'ringing'
  | 'answered'
  | 'completed'
  | 'missed'
  | 'failed'
  | 'dtmf'
  | 'unknown';

export interface ParsedVoiceWebhook {
  eventId: string;
  cpaasSessionId: string;
  eventType: VoiceEventType;
  direction: 'Inbound' | 'Outbound' | 'Unknown';
  isActive: boolean;
  callerNumber: string;
  destinationNumber: string;
  hangupCause?: string;
  status?: string;
  durationInSeconds?: number;
  recordingUrl?: string;
  dtmfDigits?: string;
  currencyCode?: string;
  amount?: string;
  raw: Record<string, string>;
}

function pickPhone(value: string | undefined): string {
  if (!value) return '';
  // AT often presents already in E.164 like +234XXX; sometimes percent-encoded.
  const decoded = value.includes('%') ? decodeURIComponent(value) : value;
  return decoded.trim();
}

function parseEventType(body: Record<string, string>): VoiceEventType {
  const direction = (body.direction ?? '').toLowerCase();
  const isActiveStr = body.isActive ?? '';
  const isActive = isActiveStr === '1' || isActiveStr.toLowerCase() === 'true';

  // DTMF
  if (body.dtmfDigits && body.dtmfDigits.length) return 'dtmf';

  // Completion has ELAPSED duration (> 0), a hangupCause, or isActive=0.
  // NB: AT sends durationInSeconds="0" on the initial inbound-call webhook, and
  // "0" is a truthy string — so parse it as a number and only treat > 0 as
  // "elapsed", otherwise every call's first webhook is misrouted as completed.
  const durationSecs = Number(body.durationInSeconds ?? '');
  const hasElapsed = Number.isFinite(durationSecs) && durationSecs > 0;
  if (hasElapsed || body.hangupCause || isActiveStr === '0') {
    const status = (body.status ?? '').toLowerCase();
    if (status === 'noanswer' || status === 'no answer') return 'missed';
    if (status === 'failed' || status === 'busy' || status === 'aborted') return 'failed';
    return 'completed';
  }

  if (direction === 'inbound' && isActive) {
    // Could be incoming or already answered; AT signals "answered" via callSessionState
    const state = (body.callSessionState ?? '').toLowerCase();
    if (state === 'answered' || state === 'inprogress' || state === 'in-progress') return 'answered';
    if (state === 'ringing') return 'ringing';
    return 'incoming_call';
  }

  if (direction === 'outbound' && isActive) {
    const state = (body.callSessionState ?? '').toLowerCase();
    if (state === 'answered' || state === 'inprogress') return 'answered';
    return 'ringing';
  }

  return 'unknown';
}

export function parseVoiceWebhook(body: Record<string, string>): ParsedVoiceWebhook {
  const sessionId = body.sessionId ?? body.SessionId ?? '';
  const eventType = parseEventType(body);
  const direction = (body.direction === 'Inbound' || body.direction === 'Outbound'
    ? body.direction
    : 'Unknown') as ParsedVoiceWebhook['direction'];
  const isActive = body.isActive === '1' || body.isActive?.toLowerCase() === 'true';
  const duration = body.durationInSeconds ? Number(body.durationInSeconds) : undefined;

  return {
    eventId: sessionId ? `${sessionId}:${eventType}` : `unknown:${Date.now()}:${eventType}`,
    cpaasSessionId: sessionId,
    eventType,
    direction,
    isActive,
    callerNumber: pickPhone(body.callerNumber),
    destinationNumber: pickPhone(body.destinationNumber),
    hangupCause: body.hangupCause,
    status: body.status,
    durationInSeconds: duration,
    recordingUrl: body.recordingUrl || undefined,
    dtmfDigits: body.dtmfDigits || undefined,
    currencyCode: body.currencyCode || undefined,
    amount: body.amount || undefined,
    raw: body,
  };
}
