/**
 * Security fix 2 (2026-07 audit): LOAD_TEST_MODE must only be enabled by the
 * exact string "true". `z.coerce.boolean()` treated ANY non-empty string —
 * including "false" — as true, silently disabling all rate limiting when the
 * shipped `.env.example` (LOAD_TEST_MODE=false) was copied verbatim.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

async function loadConfigWith(value: string | undefined): Promise<{ LOAD_TEST_MODE: boolean }> {
  vi.resetModules();
  if (value === undefined) {
    delete process.env.LOAD_TEST_MODE;
  } else {
    process.env.LOAD_TEST_MODE = value;
  }
  const { config } = await import('../../src/config/env');
  return config;
}

describe('LOAD_TEST_MODE env parsing', () => {
  const original = process.env.LOAD_TEST_MODE;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LOAD_TEST_MODE;
    } else {
      process.env.LOAD_TEST_MODE = original;
    }
    vi.resetModules();
  });

  it('parses "false" as false', async () => {
    const config = await loadConfigWith('false');
    expect(config.LOAD_TEST_MODE).toBe(false);
  });

  it('parses "true" as true', async () => {
    const config = await loadConfigWith('true');
    expect(config.LOAD_TEST_MODE).toBe(true);
  });

  it('defaults to false when unset', async () => {
    const config = await loadConfigWith(undefined);
    expect(config.LOAD_TEST_MODE).toBe(false);
  });

  it('treats arbitrary non-"true" strings as false', async () => {
    const config = await loadConfigWith('1');
    expect(config.LOAD_TEST_MODE).toBe(false);
  });
});
