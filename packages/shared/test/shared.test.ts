import { describe, expect, it, vi } from 'vitest';
import {
  AppSettingsSchema,
  DEFAULT_SETTINGS,
  GearItemSchema,
  HttpClient,
  MemoryCache,
  TrailPackError,
  addDays,
  cached,
  daysBetweenInclusive,
  formatDuration,
  formatLocalTime,
  formatWeight,
  newEntityBase,
  parseCoordinates,
  parseLocalTime,
  redactUrl,
  stableStringify,
  uuid,
} from '../src';

describe('models', () => {
  it('parses defaults for settings', () => {
    expect(DEFAULT_SETTINGS.language).toBe('cs');
    expect(DEFAULT_SETTINGS.routingProvider).toBe('brouter');
    expect(AppSettingsSchema.parse({ theme: 'dark' }).theme).toBe('dark');
  });
  it('validates gear items', () => {
    const item = GearItemSchema.parse({ ...newEntityBase(), name: 'Quilt', categoryKey: 'quilts', weightG: 520 });
    expect(item.quantity).toBe(1);
    expect(() => GearItemSchema.parse({ ...newEntityBase(), name: '', categoryKey: 'x', weightG: -1 })).toThrow();
  });
});

describe('utils', () => {
  it('generates uuids', () => {
    expect(uuid()).toMatch(/^[0-9a-f-]{36}$/);
    expect(uuid()).not.toBe(uuid());
  });
  it('handles dates and times', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetweenInclusive('2026-11-11', '2026-11-13')).toBe(3);
    expect(parseLocalTime('08:30')).toBe(510);
    expect(formatLocalTime(510)).toBe('08:30');
    expect(formatLocalTime(1500)).toBe('01:00');
    expect(formatDuration(205)).toBe('3 h 25 min');
  });
  it('formats weights', () => {
    expect(formatWeight(850)).toBe('850 g');
    expect(formatWeight(3950)).toMatch(/3,95\s?kg/);
  });
  it('parses coordinates', () => {
    expect(parseCoordinates('49.546, 18.447')).toEqual({ lat: 49.546, lon: 18.447 });
    const dms = parseCoordinates(`49°32'46.1"N 18°26'51.0"E`);
    expect(dms?.lat).toBeCloseTo(49.5461, 3);
    expect(dms?.lon).toBeCloseTo(18.4475, 3);
    expect(parseCoordinates('hello')).toBeNull();
    expect(parseCoordinates('99, 18')).toBeNull();
  });
  it('stable stringify sorts keys', () => {
    expect(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
  });
});

describe('http client', () => {
  it('retries 503 then succeeds', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const http = new HttpClient({ fetch, retries: 2, minIntervalMsPerHost: {} });
    await expect(http.json('https://example.org/x')).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('maps 401 to unauthorized without retry', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const http = new HttpClient({ fetch, retries: 3, minIntervalMsPerHost: {} });
    await expect(http.json('https://example.org/x', { provider: 'test' })).rejects.toMatchObject({ code: 'unauthorized', provider: 'test' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports offline', async () => {
    const http = new HttpClient({ fetch: vi.fn(), isOnline: () => false });
    await expect(http.json('https://example.org')).rejects.toBeInstanceOf(TrailPackError);
  });
  it('times out', async () => {
    const fetch = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((_r, reject) =>
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
        ),
    );
    const http = new HttpClient({ fetch, retries: 0, timeoutMs: 50, minIntervalMsPerHost: {} });
    await expect(http.json('https://example.org')).rejects.toMatchObject({ code: 'timeout' });
  });
  it('redacts keys', () => {
    expect(redactUrl('https://x.org/a?apikey=SECRET&b=1')).toBe('https://x.org/a?apikey=***&b=1');
  });
});

describe('cache', () => {
  it('serves stale data when loader fails', async () => {
    const cache = new MemoryCache();
    await cache.set('k', 42, -1);
    const r = await cached(cache, 'k', 1000, async () => {
      throw new TrailPackError('offline', 'offline');
    });
    expect(r).toMatchObject({ value: 42, stale: true, fromCache: true });
  });
});
