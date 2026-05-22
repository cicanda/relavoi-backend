import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TTLCache } from '../../src/utils/cache';

describe('TTLCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined for missing keys', () => {
    const cache = new TTLCache<string>();
    expect(cache.get('nope')).toBeUndefined();
  });

  it('stores and retrieves a value within TTL', () => {
    const cache = new TTLCache<string>();
    cache.set('k', 'v', 1000);
    expect(cache.get('k')).toBe('v');
  });

  it('expires entries after TTL elapses', () => {
    const cache = new TTLCache<string>();
    cache.set('k', 'v', 100);
    vi.advanceTimersByTime(101);
    expect(cache.get('k')).toBeUndefined();
  });

  it('lazy-evicts expired entries on get and decrements size', () => {
    const cache = new TTLCache<number>();
    cache.set('a', 1, 50);
    cache.set('b', 2, 500);
    expect(cache.size()).toBe(2);

    vi.advanceTimersByTime(100);
    // get() of 'a' will trigger eviction
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size()).toBe(1);
    expect(cache.get('b')).toBe(2);
  });

  it('delete removes a key', () => {
    const cache = new TTLCache<string>();
    cache.set('k', 'v', 1000);
    cache.delete('k');
    expect(cache.get('k')).toBeUndefined();
  });

  it('clear empties the cache', () => {
    const cache = new TTLCache<string>();
    cache.set('a', '1', 1000);
    cache.set('b', '2', 1000);
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });

  it('supports typed generic values', () => {
    interface Tenant {
      id: string;
      name: string;
    }
    const cache = new TTLCache<Tenant>();
    cache.set('t1', { id: 't1', name: 'Acme' }, 1000);
    const got = cache.get('t1');
    expect(got?.name).toBe('Acme');
  });
});
