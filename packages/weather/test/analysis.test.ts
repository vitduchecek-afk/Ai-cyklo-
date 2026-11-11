import { describe, expect, it } from 'vitest';
import type { GearItem, Position } from '@trailpack/shared';
import {
  OpenMeteoProvider,
  THRESHOLDS,
  analyzeWeatherRisks,
  compareDates,
  nextWeekendDates,
  recommendGearForWeather,
  selectSamplePoints,
  weatherAlongRoute,
  type ForecastResult,
  type MultiForecastProvider,
} from '../src';
import { NOW, clientFor, day, fixture, forecastOf, hour, mockFetch } from './helpers';

const codes = (a: { code: string }[]) => a.map((x) => x.code);

describe('selectSamplePoints', () => {
  // ~0.01° lat ≈ 1.11 km per vertex; 40 vertices ≈ 43 km, one clear summit (peak 1200 m, base 700 m)
  const geometry: Position[] = Array.from({ length: 41 }, (_, i) => {
    const ele = i <= 20 ? 700 + i * 25 : 1200 - (i - 20) * 25;
    return [15, 50 + i * 0.01, ele] as Position;
  });
  const times = geometry.map((_, i) => Date.parse('2026-11-12T06:00:00Z') + i * 600_000);

  it('returns start, end, every-8-km samples, summit, stage end and campsites in order', () => {
    const s = selectSamplePoints(geometry, times, { stageEnds: [25], campsites: [{ idx: 30, name: 'Pod Smrkem' }], includeSummits: true });
    expect(s[0]).toMatchObject({ kind: 'start', idx: 0, label: 'Start' });
    expect(s.at(-1)).toMatchObject({ kind: 'end', idx: 40 });
    expect(s.find((x) => x.kind === 'summit')).toMatchObject({ idx: 20, eleM: 1200 });
    expect(s.find((x) => x.kind === 'stage_end')?.idx).toBe(25);
    expect(s.find((x) => x.kind === 'campsite')).toMatchObject({ idx: 30, label: 'Nocleh: Pod Smrkem' });
    expect(s.filter((x) => x.kind === 'interval').length).toBeGreaterThanOrEqual(2);
    expect(s.map((x) => x.idx)).toEqual([...s.map((x) => x.idx)].sort((a, b) => a - b));
    expect(s.find((x) => x.idx === 20)!.etaMs).toBe(times[20]);
  });

  it('ignores bumps below 80 m prominence', () => {
    const bumpy: Position[] = Array.from({ length: 30 }, (_, i) => [15, 50 + i * 0.01, 500 + (i % 2) * 40] as Position);
    const s = selectSamplePoints(bumpy, bumpy.map((_, i) => i * 1000), { includeSummits: true });
    expect(s.some((x) => x.kind === 'summit')).toBe(false);
  });
});

describe('weatherAlongRoute', () => {
  const snezka = fixture('open-meteo-snezka-3d.json') as Record<string, unknown>;
  const cell = async () => {
    const p = new OpenMeteoProvider({ http: clientFor(mockFetch(snezka)) });
    return p.getForecast({ lat: 50.74, lon: 15.7, days: 3 });
  };

  it('applies a −0.65 °C/100 m correction, dedupes grid cells and marks beyond-horizon samples without data', async () => {
    const f = await cell();
    let requested = 0;
    const provider: MultiForecastProvider = {
      async getForecastMulti(points) {
        requested = points.length;
        return points.map(() => f as ForecastResult);
      },
    };
    const geometry: Position[] = [
      [15.7, 50.74, 1000],
      [15.701, 50.741, 1000],
      [15.702, 50.742, 1000],
    ];
    const h = 3600_000;
    const eta0 = Date.parse('2026-11-12T08:00:00Z');
    // third sample is 30 days ahead -> beyond horizon
    const r = await weatherAlongRoute({ provider, geometry, passTimesMs: [eta0, eta0 + h, eta0 + 30 * 86_400_000], everyKm: 100, now: NOW });
    expect(requested).toBe(1);
    const [a, c] = r.samples;
    expect(r.samples).toHaveLength(2);
    expect(a!.hourly?.time).toBe('2026-11-12T09:00'); // 08:00Z = 09:00 local
    expect(a!.gridEleM).toBe(1587);
    expect(a!.lapseCorrectionC).toBeCloseTo(3.8, 1);
    expect(a!.temperatureC).toBeCloseTo((a!.hourly!.temperatureC ?? 0) + 3.8, 1);
    expect(a!.confidence.level).toBe('high');
    expect(c!.beyondHorizon).toBe(true);
    expect(c!.hourly).toBeNull();
    expect(c!.temperatureC).toBeNull();
    expect(r.correctionNote).toContain('−0.65 °C');
  });
});

describe('analyzeWeatherRisks', () => {
  const baseDay = '2026-11-12';
  const hrs = (over: (h: number) => Parameters<typeof hour>[1]) => Array.from({ length: 24 }, (_, h) => hour(`${baseDay}T${String(h).padStart(2, '0')}:00`, over(h)));

  it('flags everything the real Sněžka fixture implies, with full provenance', async () => {
    const f = await new OpenMeteoProvider({ http: clientFor(mockFetch(fixture('open-meteo-snezka-3d.json'))) }).getForecast({ lat: 50.74, lon: 15.7, days: 3 });
    const adv = analyzeWeatherRisks(f, { activity: 'hiking', exposedRidge: true, maxEleM: 1600, now: NOW });
    expect(codes(adv)).toEqual(expect.arrayContaining(['weather.wind', 'weather.frost', 'weather.snow', 'weather.freezing_level', 'weather.wind_chill', 'weather.rain']));
    expect(adv.find((a) => a.code === 'weather.wind')!.severity).toBe('danger');
    expect(adv.find((a) => a.code === 'weather.frost')!.severity).toBe('danger');
    for (const a of adv) {
      expect(a.source).toBe('Open-Meteo');
      expect(a.updatedAt).toBe(f.fetchedAt);
      expect(a.basis.length).toBeGreaterThan(0);
      expect(a.uncertainty).toBeTruthy();
      expect(a.action).toBeTruthy();
    }
  });

  it('wind thresholds: 50 warning, 75 danger, stricter on ridges', () => {
    const run = (gust: number, ridge: boolean) =>
      analyzeWeatherRisks(forecastOf(hrs(() => ({ windGustsKmh: gust })), [day(baseDay, { windGustsMaxKmh: gust })]), { activity: 'hiking', exposedRidge: ridge, now: NOW }).find((a) => a.code === 'weather.wind');
    expect(run(49, false)).toBeUndefined();
    expect(run(50, false)!.severity).toBe('warning');
    expect(run(75, false)!.severity).toBe('danger');
    expect(run(40, true)!.severity).toBe('warning');
    expect(run(60, true)!.severity).toBe('danger');
  });

  it('frost: <= 0 warning, <= -5 danger; heat >= 30', () => {
    const t = (c: number) => analyzeWeatherRisks(forecastOf(hrs(() => ({ temperatureC: c, apparentTemperatureC: c })), [day(baseDay, { tempMinC: c, tempMaxC: c })], null), { activity: 'hiking', now: NOW });
    expect(codes(t(1))).not.toContain('weather.frost');
    expect(t(0).find((a) => a.code === 'weather.frost')!.severity).toBe('warning');
    expect(t(-5).find((a) => a.code === 'weather.frost')!.severity).toBe('danger');
    expect(codes(t(29))).not.toContain('weather.heat');
    expect(codes(t(30))).toContain('weather.heat');
  });

  it('thunderstorm from WMO 95-99 or CAPE > 800 with probability >= 40 %, advises leaving ridges by noon', () => {
    const byCode = analyzeWeatherRisks(forecastOf(hrs((h) => (h === 15 ? { weatherCode: 95 } : {})), [day(baseDay)]), { activity: 'hiking', now: NOW });
    const storm = byCode.find((a) => a.code === 'weather.thunderstorm')!;
    expect(storm.action).toMatch(/do poledne/);
    const byCape = analyzeWeatherRisks(forecastOf(hrs(() => ({ capeJkg: 900, precipitationProbabilityPct: 40 })), [day(baseDay)]), { activity: 'hiking', now: NOW });
    expect(codes(byCape)).toContain('weather.thunderstorm');
    const lowProb = analyzeWeatherRisks(forecastOf(hrs(() => ({ capeJkg: 900, precipitationProbabilityPct: 39 })), [day(baseDay)]), { activity: 'hiking', now: NOW });
    expect(codes(lowProb)).not.toContain('weather.thunderstorm');
  });

  it('rain: >= 10 mm/day or >= 6 rainy hours; UV >= 7; fog', () => {
    const six = analyzeWeatherRisks(forecastOf(hrs((h) => (h >= 8 && h < 14 ? { precipitationMm: 0.5 } : {})), [day(baseDay, { precipitationSumMm: 3 })]), { activity: 'hiking', now: NOW });
    expect(codes(six)).toContain('weather.rain');
    const five = analyzeWeatherRisks(forecastOf(hrs((h) => (h >= 8 && h < 13 ? { precipitationMm: 0.5 } : {})), [day(baseDay, { precipitationSumMm: 2.5 })]), { activity: 'hiking', now: NOW });
    expect(codes(five)).not.toContain('weather.rain');
    const wet = analyzeWeatherRisks(forecastOf(hrs(() => ({})), [day(baseDay, { precipitationSumMm: 10 })]), { activity: 'hiking', now: NOW });
    expect(codes(wet)).toContain('weather.rain');
    expect(codes(analyzeWeatherRisks(forecastOf(hrs(() => ({ uvIndex: 7 })), [day(baseDay)]), { activity: 'hiking', now: NOW }))).toContain('weather.uv');
    expect(codes(analyzeWeatherRisks(forecastOf(hrs((h) => (h === 6 ? { weatherCode: 45 } : {})), [day(baseDay)]), { activity: 'hiking', now: NOW }))).toContain('weather.fog');
  });

  it('exports the documented thresholds', () => {
    expect(THRESHOLDS.gustWarningKmh).toBe(50);
    expect(THRESHOLDS.gustDangerKmh).toBe(75);
  });
});

const gear = (o: Partial<GearItem> & { name: string }): GearItem =>
  ({ id: o.name, categoryKey: 'other', weightG: 100, quantity: 1, tags: [], specs: {}, condition: 'good', ...o }) as unknown as GearItem;

describe('recommendGearForWeather', () => {
  it('warns a disposable poncho is insufficient for long rain and wind (with itemIds)', () => {
    const r = recommendGearForWeather({ items: [gear({ name: 'Pláštěnka jednorázová', categoryKey: 'clothing' })], rainHours: 8, rainMm: 14, maxGustKmh: 45, sleepType: 'tent' });
    const a = r.find((x) => x.code === 'gear.rain_poncho_insufficient')!;
    expect(a.message).toBe('Na trase hrozí dlouhodobý déšť a silnější vítr. Tvoje lehká jednorázová pláštěnka nemusí poskytovat dostatečnou ochranu. Doporučuji nepromokavou bundu a ochranu batohu.');
    expect(a.itemIds).toEqual(['Pláštěnka jednorázová']);
    expect(a.severity).toBe('warning');
    expect(a.source).toBe('Open-Meteo');
    expect(a.basis.length).toBeGreaterThan(0);
  });

  it('does not flag rain protection when a waterproof jacket and pack cover exist', () => {
    const r = recommendGearForWeather({
      items: [gear({ name: 'Bunda Gore-Tex', categoryKey: 'clothing', waterproof: true }), gear({ name: 'Pláštěnka na batoh' })],
      rainHours: 8,
      rainMm: 14,
      maxGustKmh: 45,
      sleepType: 'tent',
    });
    expect(r.filter((x) => x.code.startsWith('gear.rain') || x.code === 'gear.pack_rain_protection')).toHaveLength(0);
  });

  it('judges sleeping bag by comfort/limit with a 3 °C margin and pad by R-value', () => {
    const bag = (comfort: number, limit: number) => gear({ name: 'Quilt', categoryKey: 'quilts', comfortTempC: comfort, limitTempC: limit });
    const run = (comfort: number, limit: number, night: number) => recommendGearForWeather({ items: [bag(comfort, limit), gear({ name: 'Karimatka', categoryKey: 'sleeping_pads', rValue: 4.5 })], nightMinC: night, sleepType: 'tent' });
    expect(run(-5, -10, 2).find((x) => x.code.startsWith('gear.sleeping_bag'))).toBeUndefined();
    expect(run(0, -6, 2).find((x) => x.code === 'gear.sleeping_bag_tight')).toBeTruthy();
    const cold = run(5, -1, 2).find((x) => x.code === 'gear.sleeping_bag_below_comfort')!;
    expect(cold.message).toMatch(/komfortní/);
    expect(cold.message).toMatch(/limit/);
    expect(run(5, 3, -2).find((x) => x.code === 'gear.sleeping_bag_too_cold')!.severity).toBe('danger');
    const pad = (r: number, night: number) => recommendGearForWeather({ items: [gear({ name: 'Karimatka', categoryKey: 'sleeping_pads', rValue: r })], nightMinC: night, sleepType: 'tent' }).find((x) => x.code === 'gear.pad_rvalue_low');
    expect(pad(2, 10)).toBeUndefined();
    expect(pad(1.5, 10)).toBeTruthy();
    expect(pad(2.5, 0)).toBeTruthy();
    expect(pad(3, 0)).toBeUndefined();
    expect(pad(4, -8)).toBeTruthy();
    expect(pad(4.5, -8)).toBeUndefined();
  });

  it('advises gloves/hat, sun protection, wind layer, insulation and headlamp', () => {
    const r = recommendGearForWeather({ items: [], nightMinC: -2, dayMaxC: 4, apparentMinC: -6, maxGustKmh: 55, uvMax: 7, nightHours: 14, sleepType: 'tent' });
    expect(codes(r)).toEqual(expect.arrayContaining(['gear.gloves_hat_missing', 'gear.sun_protection', 'gear.wind_layer_missing', 'gear.insulation_missing', 'gear.headlamp_missing']));
    for (const a of r) {
      expect(a.suggestion).toBeTruthy();
      expect(a.basis.length).toBeGreaterThan(0);
    }
  });

  it('skips sleeping-system advice when sleeping in a hut', () => {
    const r = recommendGearForWeather({ items: [], nightMinC: -10, sleepType: 'mountain_hut' });
    expect(codes(r).filter((c) => c.includes('sleep') || c.includes('pad'))).toHaveLength(0);
  });
});

describe('compareDates', () => {
  const mk = (rain: number, gust: number) => forecastOf(Array.from({ length: 24 }, (_, h) => hour(`2026-11-12T${String(h).padStart(2, '0')}:00`, { precipitationMm: rain / 24, windGustsKmh: gust })), [day('2026-11-12', { precipitationSumMm: rain, windGustsMaxKmh: gust })]);

  it('ranks dry/calm above wet/windy and lists beyond-horizon dates explicitly', () => {
    const r = compareDates({
      candidates: [
        { id: 'wet', label: 'Mokrý', dateIso: '2026-11-12', days: 1 },
        { id: 'dry', label: 'Suchý', dateIso: '2026-11-12', days: 1 },
        { id: 'far', label: 'Prosinec', dateIso: '2026-12-20', days: 2 },
      ],
      forecasts: { wet: mk(20, 70), dry: mk(0, 20), far: null },
      preferences: { avoidRain: true, maxGustKmh: 50 },
      now: NOW,
    });
    expect(r.ranked.map((x) => x.id)).toEqual(['dry', 'wet']);
    expect(r.ranked[0]!.score).toBeGreaterThan(r.ranked[1]!.score);
    expect(r.ranked[1]!.reasons.join(' ')).toMatch(/limit 50 km\/h/);
    expect(r.ranked[0]!.confidence).toBe('high');
    expect(r.beyondHorizon).toHaveLength(1);
    expect(r.beyondHorizon[0]).toMatchObject({ id: 'far', reason: 'horizon' });
    expect(r.beyondHorizon[0]!.message).toMatch(/za horizontem předpovědi/);
    expect(r.ranked.find((x) => x.id === 'far')).toBeUndefined();
  });

  it('finds the next weekend', () => {
    expect(nextWeekendDates(Date.parse('2026-11-11T08:00:00Z'))).toEqual({ saturday: '2026-11-14', sunday: '2026-11-15' });
    expect(nextWeekendDates(Date.parse('2026-11-14T08:00:00Z')).saturday).toBe('2026-11-14');
    expect(nextWeekendDates(Date.parse('2026-11-15T08:00:00Z')).saturday).toBe('2026-11-21');
  });
});
