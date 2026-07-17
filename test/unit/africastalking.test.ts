import { describe, it, expect } from 'vitest';
import { parseVoiceWebhook } from '../../src/services/africastalking/webhook-parser';
import { parseSmsWebhook } from '../../src/services/africastalking/sms-parser';
import {
  buildDialResponse,
  buildRejectResponse,
  buildPlayMessageResponse,
  buildRedirectResponse,
  buildEmptyResponse,
} from '../../src/services/africastalking/response-builder';

describe("Africa's Talking parsers", () => {
  describe('parseVoiceWebhook', () => {
    it('treats an inbound active call (callSessionState=Ringing) as incoming_call', () => {
      // AT's FIRST inbound webhook — the one it expects us to answer with a
      // <Dial> — carries callSessionState=Ringing + isActive=1. That is the
      // actionable "route this call now" event, NOT a passive status update.
      const body = {
        sessionId: 'AT-CALL-123',
        isActive: '1',
        direction: 'Inbound',
        callerNumber: '+2348012345678',
        destinationNumber: '+2348000000001',
        callSessionState: 'Ringing',
      };
      const parsed = parseVoiceWebhook(body);
      expect(parsed.cpaasSessionId).toBe('AT-CALL-123');
      expect(parsed.direction).toBe('Inbound');
      expect(parsed.isActive).toBe(true);
      expect(parsed.callerNumber).toBe('+2348012345678');
      expect(parsed.destinationNumber).toBe('+2348000000001');
      expect(parsed.eventType).toBe('incoming_call');
      expect(parsed.eventId).toBe('AT-CALL-123:incoming_call');
    });

    it('treats an active inbound call with durationInSeconds=0 as incoming_call', () => {
      // AT includes durationInSeconds=0 on the INITIAL inbound-call webhook.
      // "0" is a truthy string, so the completion guard must not fire here —
      // otherwise the very first webhook of every call is misrouted as "completed".
      const body = {
        sessionId: 'AT-CALL-000',
        isActive: '1',
        direction: 'Inbound',
        callerNumber: '+2348012345678',
        destinationNumber: '+2348000000001',
        durationInSeconds: '0',
        amount: '0.00',
        currencyCode: 'NGN',
      };
      const parsed = parseVoiceWebhook(body);
      expect(parsed.eventType).toBe('incoming_call');
      expect(parsed.eventId).toBe('AT-CALL-000:incoming_call');
    });

    it('classifies completion when duration is present', () => {
      const body = {
        sessionId: 'AT-CALL-456',
        isActive: '0',
        direction: 'Inbound',
        callerNumber: '+2348012345678',
        destinationNumber: '+2348000000001',
        durationInSeconds: '42',
        status: 'Success',
        hangupCause: 'NORMAL_CLEARING',
      };
      const parsed = parseVoiceWebhook(body);
      expect(parsed.eventType).toBe('completed');
      expect(parsed.durationInSeconds).toBe(42);
      expect(parsed.hangupCause).toBe('NORMAL_CLEARING');
    });

    it('classifies missed and failed correctly', () => {
      const missed = parseVoiceWebhook({
        sessionId: 'AT-CALL-789',
        isActive: '0',
        direction: 'Inbound',
        callerNumber: '+2348012345678',
        destinationNumber: '+2348000000001',
        hangupCause: 'NO_ANSWER',
        status: 'NoAnswer',
      });
      expect(missed.eventType).toBe('missed');

      const failed = parseVoiceWebhook({
        sessionId: 'AT-CALL-790',
        isActive: '0',
        direction: 'Inbound',
        callerNumber: '+2348012345678',
        destinationNumber: '+2348000000001',
        status: 'Failed',
      });
      expect(failed.eventType).toBe('failed');
    });

    it('classifies DTMF events', () => {
      const parsed = parseVoiceWebhook({
        sessionId: 'AT-CALL-DTMF',
        isActive: '1',
        direction: 'Inbound',
        callerNumber: '+2348012345678',
        destinationNumber: '+2348000000001',
        dtmfDigits: '1',
      });
      expect(parsed.eventType).toBe('dtmf');
      expect(parsed.dtmfDigits).toBe('1');
    });

    it('returns deterministic eventId built from sessionId + type', () => {
      const body = {
        sessionId: 'AT-XYZ',
        isActive: '1',
        direction: 'Inbound',
        callerNumber: '+2348012345678',
        destinationNumber: '+2348000000001',
        callSessionState: 'Answered',
      };
      const a = parseVoiceWebhook(body);
      const b = parseVoiceWebhook(body);
      expect(a.eventId).toBe(b.eventId);
      expect(a.eventType).toBe('answered');
    });
  });

  describe('parseSmsWebhook', () => {
    it('parses an inbound SMS', () => {
      const body = {
        id: 'ATXid_12345',
        from: '+2348012345678',
        to: '+2348000000001',
        text: 'Hello world',
        date: '2026-05-01T10:00:00Z',
        networkCode: '62120',
      };
      const parsed = parseSmsWebhook(body);
      expect(parsed.cpaasMessageId).toBe('ATXid_12345');
      expect(parsed.from).toBe('+2348012345678');
      expect(parsed.to).toBe('+2348000000001');
      expect(parsed.text).toBe('Hello world');
      expect(parsed.eventId).toBe('sms:ATXid_12345');
    });

    it('prefers linkId over id for eventId stability when present', () => {
      const parsed = parseSmsWebhook({
        id: 'ATXid_99',
        linkId: 'STABLE-1',
        from: '+2348012345678',
        to: '+2348000000001',
        text: 'reply',
      });
      expect(parsed.eventId).toBe('sms:STABLE-1');
      expect(parsed.linkId).toBe('STABLE-1');
    });

    it('coerces phones to E.164', () => {
      const parsed = parseSmsWebhook({
        id: 'ATXid_2',
        from: '2348012345678',
        to: '2348000000001',
        text: 'no plus',
      });
      expect(parsed.from).toBe('+2348012345678');
      expect(parsed.to).toBe('+2348000000001');
    });
  });

  describe('response-builder', () => {
    it('buildDialResponse: emits <Dial> with callerId and recording attrs', () => {
      const xml = buildDialResponse({
        destination: '+2348012345678',
        callerId: '+2348000000001',
        recordingEnabled: true,
        consentText: 'This call may be recorded.',
        maxDurationSeconds: 3600,
      });
      expect(xml).toContain('<?xml');
      expect(xml).toContain('<Response>');
      expect(xml).toContain('<Say voice="woman">This call may be recorded.</Say>');
      expect(xml).toContain('record="true"');
      expect(xml).toContain('callerId="+2348000000001"');
      expect(xml).toContain('phoneNumbers="+2348012345678"');
      expect(xml).toContain('maxDuration="3600"');
    });

    it('buildDialResponse: uses Play when consentAudioUrl provided', () => {
      const xml = buildDialResponse({
        destination: '+2348012345678',
        consentAudioUrl: 'https://cdn.example.com/consent.mp3',
      });
      expect(xml).toContain('<Play url="https://cdn.example.com/consent.mp3"/>');
      expect(xml).not.toContain('<Say');
    });

    it('buildRejectResponse: returns Say + Hangup', () => {
      const xml = buildRejectResponse({ reason: 'expired' });
      expect(xml).toContain('<Say');
      expect(xml).toContain('no longer in service');
      expect(xml).toContain('<Hangup/>');
    });

    it('buildRejectResponse: unauthorized uses tailored message', () => {
      const xml = buildRejectResponse({ reason: 'unauthorized' });
      expect(xml).toContain('not authorized');
    });

    it('buildPlayMessageResponse: includes Play and Hangup', () => {
      const xml = buildPlayMessageResponse('https://cdn.example.com/msg.mp3');
      expect(xml).toContain('<Play url="https://cdn.example.com/msg.mp3"/>');
      expect(xml).toContain('<Hangup/>');
    });

    it('buildRedirectResponse: dials support number with callerId', () => {
      const xml = buildRedirectResponse('+2348099999999', '+2348000000001');
      expect(xml).toContain('callerId="+2348000000001"');
      expect(xml).toContain('phoneNumbers="+2348099999999"');
    });

    it('buildEmptyResponse: returns empty <Response/>', () => {
      const xml = buildEmptyResponse();
      expect(xml).toContain('<Response>');
      expect(xml).toContain('</Response>');
    });

    it('escapes XML-special characters in messages', () => {
      const xml = buildRejectResponse({
        reason: 'unauthorized',
        message: 'A & B <c> "d" \'e\'',
      });
      expect(xml).toContain('&amp;');
      expect(xml).toContain('&lt;');
      expect(xml).toContain('&gt;');
      expect(xml).toContain('&quot;');
      expect(xml).toContain('&apos;');
    });
  });
});
