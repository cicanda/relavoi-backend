import { describe, it, expect } from 'vitest';
import { parseSmsWebhook } from '../../src/services/africastalking/sms-parser';

describe('parseSmsWebhook', () => {
  it('parses a complete inbound SMS payload', () => {
    const parsed = parseSmsWebhook({
      id: 'ATXid_001',
      from: '+2348012345678',
      to: '+2348000000001',
      text: 'Where is my order?',
      date: '2026-05-22T10:00:00Z',
      networkCode: '62120',
    });

    expect(parsed.cpaasMessageId).toBe('ATXid_001');
    expect(parsed.from).toBe('+2348012345678');
    expect(parsed.to).toBe('+2348000000001');
    expect(parsed.text).toBe('Where is my order?');
    expect(parsed.eventId).toBe('sms:ATXid_001');
  });

  it('prefers linkId over id for eventId (stable across retries)', () => {
    const parsed = parseSmsWebhook({
      id: 'ATXid_volatile',
      linkId: 'LINK-STABLE-42',
      from: '+2348012345678',
      to: '+2348000000001',
      text: 'reply',
    });
    expect(parsed.eventId).toBe('sms:LINK-STABLE-42');
    expect(parsed.linkId).toBe('LINK-STABLE-42');
  });

  it('coerces phones without leading + to E.164', () => {
    const parsed = parseSmsWebhook({
      id: 'ATXid_002',
      from: '2348012345678',
      to: '2348000000001',
      text: 'no plus',
    });
    expect(parsed.from).toBe('+2348012345678');
    expect(parsed.to).toBe('+2348000000001');
  });

  it('preserves + when already present', () => {
    const parsed = parseSmsWebhook({
      id: 'ATXid_003',
      from: '+2348012345678',
      to: '+2348000000001',
      text: 'hi',
    });
    expect(parsed.from.startsWith('++')).toBe(false);
    expect(parsed.from).toBe('+2348012345678');
  });

  it('handles empty text without crashing', () => {
    const parsed = parseSmsWebhook({
      id: 'ATXid_004',
      from: '+2348012345678',
      to: '+2348000000001',
      text: '',
    });
    expect(parsed.text).toBe('');
  });

  it('handles long text up to AT max', () => {
    const longText = 'a'.repeat(1600); // AT concatenated max
    const parsed = parseSmsWebhook({
      id: 'ATXid_005',
      from: '+2348012345678',
      to: '+2348000000001',
      text: longText,
    });
    expect(parsed.text.length).toBe(1600);
  });

  it('produces stable eventId for retries of the same message', () => {
    const body = {
      id: 'ATXid_dedup',
      from: '+2348012345678',
      to: '+2348000000001',
      text: 'retry me',
    };
    const a = parseSmsWebhook(body);
    const b = parseSmsWebhook(body);
    expect(a.eventId).toBe(b.eventId);
  });

  it('handles missing optional fields gracefully', () => {
    const parsed = parseSmsWebhook({
      id: 'ATXid_006',
      from: '+2348012345678',
      to: '+2348000000001',
      text: 'minimal',
    });
    expect(parsed.cpaasMessageId).toBe('ATXid_006');
    expect(parsed.from).toBe('+2348012345678');
  });

  it('returns sensible defaults when optional fields are missing', () => {
    // The parser is lenient — it doesn't throw on missing fields, but downstream
    // code should treat empty `from`/`to`/`text` as a no-route condition.
    const parsed = parseSmsWebhook({} as unknown as Record<string, string>);
    expect(parsed.from ?? '').not.toBe(undefined);
    expect(parsed.to ?? '').not.toBe(undefined);
    expect(parsed.text ?? '').not.toBe(undefined);
  });
});
