import { describe, expect, it, vi } from 'vitest';
import { MemoryCache, TrailPackError } from '@trailpack/shared';
import { OpenMeteoProvider, beaufort, describeWeatherCode, forecastConfidence, windDirectionLabel } from '../src';
import { clientFor, fixture, mockFetch } from './helpers';

describe('OpenMeteoProvider', () => {
  it('maps the recorded Sněžka response to the WeatherForecast model', async () => {
    const m = mockFetch(fixture('open-meteo-snezka-3d.json'));
    const p = new OpenMeteoProvider({ http: clientFor(m) });
    const f = await p.getForecast({ lat: 50.7417, lon: 15.7021, days: 3 });
    expect(f.hourly).toHaveLength(72);
    expect(f.daily.map((d) => d.date)).toEqual(['2026-11-11', '2026-11-12', '2026-11-13']);
    expect(f.eleM).toBe(1587);
    expect(f.timezone).toBe('Europe/Prague');
    expect(f.stale).toBe(false);
    expect(f.utcOffsetSeconds).toBe(3600);
    expect(f.provider).toBe('Open-Meteo');
    const h0 = f.hourly[0]!;
    expect(h0.time).toBe('2026-11-11T00:00');
    expect(typeof h0.temperatureC).toBe('number');
    expect(typeof h0.isDay).toBe('boolean');
    expect(Math.max(...f.hourly.map((h) => h.windGustsKmh ?? 0))).toBeCloseTo(87.1, 1);
    expect(f.daily[1]!.precipitationSumMm).toBeCloseTo(10.68, 2);
    expect(f.daily[0]!.sunrise).toBe('2026-11-11T07:05');
    const url = decodeURIComponent(m.calls[0]!);
    for (const v of ['cape', 'freezing_level_height', 'snow_depth', 'wind_gusts_10m', 'uv_index_max', 'sunset', 'timezone=auto', 'forecast_days=3', 'wind_speed_unit=kmh']) expect(url).toContain(v);
  });

  it('maps multi-coordinate responses and batches into one request', async () => {
    const m = mockFetch(fixture('open-meteo-multi-2pts.json'));
    const p = new OpenMeteoProvider({ http: clientFor(m) });
    const r = await p.getForecastMulti([
      { lat: 50.0775, lon: 14.4272, days: 2 },
      { lat: 49.1645, lon: 20.1, days: 2 },
    ]);
    expect(r).toHaveLength(2);
    expect(m.calls).toHaveLength(1);
    expect(r[0]!.eleM).toBe(220);
    expect(r[1]!.eleM).toBe(2499);
    expect(r[1]!.daily[1]!.windGustsMaxKmh).toBeCloseTo(55.8, 1);
    expect(decodeURIComponent(m.calls[0]!)).toMatch(/latitude=50\.0775,49\.1645/);
  });

  it('maps HTTP 400 to invalid_input with the API reason', async () => {
    const m = mockFetch(fixture('open-meteo-error-400.json'), 400);
    const p = new OpenMeteoProvider({ http: clientFor(m) });
    await expect(p.getForecast({ lat: 50, lon: 15, days: 3 })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('Allowed range 0 to 16') });
  });

  it('rejects days outside 1-16 before any request', async () => {
    const m = mockFetch({});
    const p = new OpenMeteoProvider({ http: clientFor(m) });
    for (const days of [0, 17, 2.5]) await expect(p.getForecast({ lat: 50, lon: 15, days })).rejects.toBeInstanceOf(TrailPackError);
    expect(m.calls).toHaveLength(0);
  });

  it('caches for 60 minutes and serves stale data when the network fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-11T08:00:00Z'));
      const m = mockFetch(fixture('open-meteo-snezka-3d.json'));
      const p = new OpenMeteoProvider({ http: clientFor(m), cache: new MemoryCache() });
      const req = { lat: 50.7417, lon: 15.7021, days: 3 };
      await p.getForecast(req);
      const again = await p.getForecast(req);
      expect(m.calls).toHaveLength(1);
      expect(again.stale).toBe(false);
      vi.setSystemTime(new Date('2026-11-11T09:30:00Z'));
      const failing = new OpenMeteoProvider({
        http: clientFor({ calls: [], fetch: async () => Promise.reject(new TypeError('fetch failed')) }),
        cache: (p as unknown as { cache: MemoryCache }).cache,
      });
      const stale = await failing.getForecast(req);
      expect(stale.stale).toBe(true);
      expect(stale.fetchedAt).toBe('2026-11-11T08:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('forecastConfidence', () => {
  const now = Date.parse('2026-11-11T10:00:00Z');
  it.each([
    ['2026-11-11', 'high'],
    ['2026-11-13', 'high'],
    ['2026-11-14', 'medium'],
    ['2026-11-17', 'medium'],
    ['2026-11-18', 'low'],
    ['2026-11-26', 'low'],
    ['2026-11-27', 'none'],
    ['2026-12-31', 'none'],
    ['2026-11-10', 'none'],
  ])('%s -> %s', (date, level) => {
    expect(forecastConfidence(date, now).level).toBe(level);
  });
  it('explains beyond-horizon dates in Czech and does not call it a forecast', () => {
    expect(forecastConfidence('2026-12-24', now).explanation).toMatch(/horizont/);
  });
});

describe('codes', () => {
  it('describes WMO codes in Czech', () => {
    expect(describeWeatherCode(95)).toMatchObject({ label: 'Bouřka', severity: 'danger', icon: 'storm' });
    expect(describeWeatherCode(0).label).toBe('Jasno');
    expect(describeWeatherCode(1234).label).toBe('Neznámé počasí');
  });
  it('names wind directions', () => {
    expect([0, 45, 90, 135, 180, 225, 270, 315, 360, 350].map(windDirectionLabel)).toEqual(['S', 'SV', 'V', 'JV', 'J', 'JZ', 'Z', 'SZ', 'S', 'S']);
  });
  it('computes Beaufort', () => {
    expect(beaufort(0).force).toBe(0);
    expect(beaufort(25).force).toBe(4);
    expect(beaufort(55)).toMatchObject({ force: 7, label: 'prudký vítr' });
    expect(beaufort(200).force).toBe(12);
  });
});
