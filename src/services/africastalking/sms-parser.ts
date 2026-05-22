/**
 * Africa's Talking incoming SMS webhook parser.
 *
 * AT delivers inbound SMS as form-urlencoded POST with at minimum:
 *   from, to, text, id (AT-assigned), linkId (optional), date, networkCode
 *
 * Spec ref: https://developers.africastalking.com/docs/sms/callback
 */

export interface ParsedSmsWebhook {
  eventId: string;
  cpaasMessageId: string;
  from: string;
  to: string;
  text: string;
  date?: string;
  linkId?: string;
  networkCode?: string;
  raw: Record<string, string>;
}

function decode(value: string | undefined): string {
  if (!value) return '';
  // AT generally sends already-decoded values via formbody, but %2B can leak through.
  try {
    return decodeURIComponent(value.replace(/\+/g, '%2B')).trim();
  } catch {
    return value.trim();
  }
}

function ensureE164(phone: string): string {
  const trimmed = phone.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('+')) return trimmed;
  if (/^\d+$/.test(trimmed)) return `+${trimmed}`;
  return trimmed;
}

export function parseSmsWebhook(body: Record<string, string>): ParsedSmsWebhook {
  const id = body.id ?? body.Id ?? '';
  const linkId = body.linkId ?? body.LinkId ?? undefined;
  const from = ensureE164(decode(body.from ?? body.From ?? ''));
  const to = ensureE164(decode(body.to ?? body.To ?? ''));
  const text = decode(body.text ?? body.Text ?? '');

  const stableId = linkId || id;

  return {
    eventId: stableId ? `sms:${stableId}` : `sms:unknown:${Date.now()}`,
    cpaasMessageId: id,
    from,
    to,
    text,
    date: body.date ?? body.Date,
    linkId,
    networkCode: body.networkCode ?? body.NetworkCode,
    raw: body,
  };
}
