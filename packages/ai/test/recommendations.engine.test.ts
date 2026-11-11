import { describe, expect, it } from 'vitest';
import { analyzeTrip, prioritize, type TripAnalysisDay, type TripAnalysisInput } from '../src';

const day = (over: Partial<TripAnalysisDay> = {}): TripAnalysisDay => ({
  index: 0,
  distanceM: 15000,
  ascentM: 500,
  movingMin: 300,
  arrivalTime: '15:00',
  sunsetTime: '21:00',
  campsite: { legalStatus: 'verified_allowed', name: 'Kemp' },
  ...over,
});
const input = (over: Partial<TripAnalysisInput> = {}): TripAnalysisInput => ({
  settings: { dailyDistanceKm: 20, maxDailyAscentM: 1200, sleepType: 'tent' },
  days: [day(), day({ index: 1, campsite: undefined })],
  fitness: 'moderate',
  ...over,
});
const codes = (i: TripAnalysisInput) => analyzeTrip(i).map((a) => a.code);

describe('recommendation rules', () => {
  it('is quiet for a comfortable trip', () => {
    expect(analyzeTrip(input())).toEqual([]);
  });

  it('flags stages that are too long or demanding for the fitness', () => {
    const r = analyzeTrip(input({ days: [day({ distanceM: 26000, ascentM: 1500 }), day({ index: 1, campsite: undefined })], fitness: 'low' }));
    expect(r.map((a) => a.code)).toEqual(expect.arrayContaining(['stage.too_long', 'stage.too_demanding']));
    const demanding = r.find((a) => a.code === 'stage.too_demanding')!;
    expect(demanding.severity).toBe('danger');
    expect(demanding.message).toMatch(/km/);
    expect(demanding.basis.length).toBeGreaterThan(0);
    expect(demanding.alternatives.length).toBeGreaterThan(0);
    expect(demanding.uncertainty).toBeDefined();
  });

  it('flags moving time over 9 h', () => {
    const r = analyzeTrip(input({ days: [day({ movingMin: 570 }), day({ index: 1, campsite: undefined })] }));
    expect(r.find((a) => a.code === 'time.long_day')?.severity).toBe('warning');
    expect(analyzeTrip(input({ days: [day({ movingMin: 700 })] })).find((a) => a.code === 'time.long_day')?.severity).toBe('danger');
  });

  it('checks daylight reserve and arrival after sunset', () => {
    expect(codes(input({ days: [day({ arrivalTime: '20:30' })] }))).toContain('daylight.low_reserve');
    const after = analyzeTrip(input({ days: [day({ arrivalTime: '21:40' })] })).find((a) => a.code === 'daylight.after_sunset');
    expect(after?.severity).toBe('danger');
    expect(codes(input({ days: [day({ arrivalTime: '16:00' })] }))).not.toContain('daylight.low_reserve');
  });

  it('compares the sleeping bag with night temperature', () => {
    const cold = (n: number) => input({ sleepingBagComfortC: 0, days: [day({ nightMinC: n })] });
    expect(analyzeTrip(cold(-8)).find((a) => a.code === 'sleep.bag_insufficient')?.severity).toBe('danger');
    expect(analyzeTrip(cold(-2)).find((a) => a.code === 'sleep.bag_insufficient')?.severity).toBe('warning');
    expect(analyzeTrip(cold(2)).find((a) => a.code === 'sleep.bag_marginal')?.severity).toBe('info');
    expect(codes(cold(8))).toEqual([]);
  });

  it('reports water problems', () => {
    expect(analyzeTrip(input({ waterPlan: { sufficient: false, deficitL: 3 } })).find((a) => a.code === 'water.deficit')?.severity).toBe('danger');
    expect(codes(input({ days: [day({ waterSourcesCount: 0 })] }))).toContain('water.no_sources');
    expect(codes(input({ days: [day({ waterCarryL: 5 })] }))).toContain('water.heavy_carry');
    expect(codes(input({ waterPlan: { sufficient: true } }))).toEqual([]);
  });

  it('reports food deficit and surplus', () => {
    expect(analyzeTrip(input({ food: { plannedKcalPerDay: 2000, neededKcalPerDay: 3200 } })).find((a) => a.code === 'food.deficit')?.severity).toBe('danger');
    expect(analyzeTrip(input({ food: { plannedKcalPerDay: 2800, neededKcalPerDay: 3000 } })).find((a) => a.code === 'food.deficit')?.severity).toBeUndefined();
    expect(codes(input({ food: { plannedKcalPerDay: 4500, neededKcalPerDay: 3000 } }))).toContain('food.surplus');
  });

  it('reports pack weight vs target and body weight', () => {
    const over = analyzeTrip(input({ packWeights: { baseG: 4600, totalG: 9000, targetBaseG: 4000, bodyWeightKg: 80 } }));
    expect(over.find((a) => a.code === 'pack.over_target')?.params['overG']).toBe(600);
    expect(codes(input({ packWeights: { baseG: 3000, totalG: 9000, targetBaseG: 4000, bodyWeightKg: 80 } }))).toEqual([]);
    expect(analyzeTrip(input({ packWeights: { baseG: 3000, totalG: 17000, bodyWeightKg: 70 } })).find((a) => a.code === 'pack.heavy_for_body')?.severity).toBe('warning');
    expect(analyzeTrip(input({ packWeights: { baseG: 3000, totalG: 20000, bodyWeightKg: 70 } })).find((a) => a.code === 'pack.heavy_for_body')?.severity).toBe('danger');
  });

  it('reports battery reserve', () => {
    expect(codes(input({ power: { sufficient: true, reservePct: 12 } }))).toContain('power.low_reserve');
    expect(analyzeTrip(input({ power: { sufficient: false, reservePct: 0 } }))[0]?.severity).toBe('danger');
    expect(codes(input({ power: { sufficient: true, reservePct: 40 } }))).toEqual([]);
  });

  it('reports illegal / unverified / missing campsites', () => {
    const r = (s: 'prohibited' | 'unverified' | 'conditional') => analyzeTrip(input({ days: [day({ campsite: { legalStatus: s } }), day({ index: 1, campsite: undefined })] }));
    expect(r('prohibited')[0]?.code).toBe('camp.prohibited');
    expect(r('unverified').map((a) => a.code)).toContain('camp.unverified');
    expect(r('conditional')[0]?.severity).toBe('info');
    expect(codes(input({ days: [day({ campsite: undefined }), day({ index: 1, campsite: undefined })] }))).toContain('camp.missing');
  });

  it('suggests weight savings and passes weather risks through', () => {
    expect(codes(input({ optimizerSavingsG: 800 }))).toContain('gear.savings_potential');
    expect(codes(input({ optimizerSavingsG: 100 }))).toEqual([]);
    const risk = { code: 'weather.storm', severity: 'danger' as const, message: 'Bouřky', params: {}, basis: ['CAPE'] };
    const r = analyzeTrip(input({ forecastRisks: [risk] }));
    expect(r.map((a) => a.code)).toEqual(['weather.storm', 'weather.consider_changes']);
    expect(r[1]!.alternatives.length).toBeGreaterThan(0);
  });

  it('prioritizes by severity and removes duplicates', () => {
    const mk = (code: string, severity: 'info' | 'warning' | 'danger', day?: number) => ({ code, severity, message: code, params: (day === undefined ? {} : { day }) as Record<string, number>, basis: [] as string[] });
    const out = prioritize([mk('a', 'info'), mk('b', 'danger'), mk('c', 'warning'), mk('b', 'danger'), mk('d', 'warning', 1), mk('d', 'warning', 2), mk('d', 'warning', 1)]);
    expect(out.map((a) => `${a.code}${a.params['day'] ?? ''}`)).toEqual(['b', 'c', 'd1', 'd2', 'a']);
  });
});
