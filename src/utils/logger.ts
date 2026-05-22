import pino from 'pino';
import { config } from '../config/env';

export const logger = pino({
  level: config.LOG_LEVEL,
  transport:
    config.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } }
      : undefined,
  redact: {
    paths: [
      '*.phone',
      '*.phoneNumber',
      '*.party_a_phone',
      '*.party_b_phone',
      '*.party_a_phone_enc',
      '*.party_b_phone_enc',
      '*.agentPhone',
      '*.customerPhone',
      '*.userPhone',
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'req.headers["x-api-secret"]',
      'res.headers["set-cookie"]',
    ],
    censor: '[REDACTED]',
  },
  base: {
    service: 'relavoi-api',
    env: config.NODE_ENV,
  },
});
