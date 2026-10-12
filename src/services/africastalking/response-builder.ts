/**
 * Africa's Talking Voice XML response builder.
 *
 * Africa's Talking expects an XML document in the HTTP response body to
 * instruct the call action. Supported tags include <Say>, <Play>, <Dial>,
 * <Reject>, <Hangup>, <GetDigits>, <Record>, <Conference>.
 *
 * Spec ref: https://developers.africastalking.com/docs/voice/voiceresponse
 */

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface BuildDialResponseArgs {
  destination: string;
  callerId?: string;
  recordingEnabled?: boolean;
  consentAudioUrl?: string;
  consentText?: string;
  maxDurationSeconds?: number;
  ringbackTone?: string;
}

export function buildDialResponse(args: BuildDialResponseArgs): string {
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>'];

  if (args.consentAudioUrl) {
    parts.push(`<Play url="${escapeXml(args.consentAudioUrl)}"/>`);
  } else if (args.consentText) {
    parts.push(`<Say voice="woman">${escapeXml(args.consentText)}</Say>`);
  }

  const dialAttrs: string[] = [];
  if (args.callerId) dialAttrs.push(`callerId="${escapeXml(args.callerId)}"`);
  if (args.recordingEnabled) dialAttrs.push(`record="true"`);
  if (args.maxDurationSeconds && args.maxDurationSeconds > 0) {
    dialAttrs.push(`maxDuration="${args.maxDurationSeconds}"`);
  }
  if (args.ringbackTone) dialAttrs.push(`ringbackTone="${escapeXml(args.ringbackTone)}"`);

  const attrStr = dialAttrs.length ? ' ' + dialAttrs.join(' ') : '';
  parts.push(`<Dial${attrStr} phoneNumbers="${escapeXml(args.destination)}"/>`);
  parts.push('</Response>');

  return parts.join('');
}

export type RejectReason = 'no_session' | 'expired' | 'unauthorized' | 'rate_limited';

export function buildRejectResponse(args: { reason: RejectReason; message?: string }): string {
  const message =
    args.message ??
    (args.reason === 'unauthorized'
      ? 'This number is not authorized to make this call'
      : 'This number is no longer in service');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `<Say voice="woman">${escapeXml(message)}</Say>`,
    '<Hangup/>',
    '</Response>',
  ].join('');
}

/**
 * Play a recording, or speak text when there is no recording to play.
 *
 * A decision may carry a message without an audio file (a sandbox notice, a
 * tenant message with no uploaded clip). Previously only the URL was honoured,
 * so those callers heard `<Play url="">` -- silence -- and the text was lost.
 */
export function buildPlayMessageResponse(audioUrl: string, text?: string): string {
  const body = audioUrl
    ? `<Play url="${escapeXml(audioUrl)}"/>`
    : text
      ? `<Say>${escapeXml(text)}</Say>`
      : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    body,
    '<Hangup/>',
    '</Response>',
  ].join('');
}

export function buildRedirectResponse(supportPhone: string, callerId?: string): string {
  const callerAttr = callerId ? ` callerId="${escapeXml(callerId)}"` : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `<Dial${callerAttr} phoneNumbers="${escapeXml(supportPhone)}"/>`,
    '</Response>',
  ].join('');
}

export function buildEmptyResponse(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}
