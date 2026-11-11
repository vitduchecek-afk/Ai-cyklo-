import { describe, expect, it } from 'vitest';
import type { Position } from '@trailpack/shared';
import { TrailPackError } from '@trailpack/shared';
import { cumulativeMovingMinutes, estimateMovingTime, estimateTotalTime, passTimes } from '../src/time';
import { splitIntoStages, suggestDayCount } from '../src/stages';
import type { TimeParams } from '../src/time';

const hiking: TimeParams = { activity: 'hiking', fitness: 'moderate', paceKmh: 4 };

/** Straight line along the equator, 0.01° (~1112 m) per step, optional elevations. */
function eqLine(n: number, eles?: number[]): Position[] {
  return Array.from({ length: n }, (_, i) => (eles ? [i * 0.01, 0, eles[i]!] : [i * 0.01, 0]) as Position);
}

describe('estimateMovingTime – hiking (DIN 33466)', () => {
  it('matches the hand-computed DIN 33466 example (12 km, +600, -200 at 4 km/h = 252 min)', () => {
    const res = estimateMovingTime({ ...hiking, distanceM: 12000, ascentM: 600, descentM: 200 });
    expect(res.model).toBe('DIN33466');
    expect(res.movingMin).toBe(252); // horizontal 180, vertical 120 + 24 = 144 -> 180 + 72
    expect(res.uncertaintyPct).toBeGreaterThan(0);
    expect(res.explanation.join(' ')).toContain('DIN 33466');
  });

  it('applies pack load above 10 % of body weight (15 kg / 75 kg -> factor 1.06)', () => {
    const res = estimateMovingTime({ ...hiking, distanceM: 12000, ascentM: 600, descentM: 200, packWeightKg: 15 });
    expect(res.factors.load).toBe(1.06);
    expect(res.movingMin).toBeCloseTo(267.1, 1);
    expect(res.explanation.join(' ')).toContain('předpokládáno 75 kg');
  });

  it('applies terrain factor (rough = 1.25)', () => {
    const res = estimateMovingTime({ ...hiking, distanceM: 12000, ascentM: 600, descentM: 200, terrain: 'rough' });
    expect(res.movingMin).toBe(315);
    expect(res.uncertaintyPct).toBeGreaterThan(20);
  });

  it('uses default pace and vertical fitness factor for low fitness', () => {
    const res = estimateMovingTime({ distanceM: 12000, ascentM: 600, descentM: 200, activity: 'hiking', fitness: 'low' });
    // horizontal 12/3.5 h = 205.71 min; vertical 144 * 1.2 = 172.8 -> 205.71 + 86.4
    expect(res.movingMin).toBeCloseTo(292.1, 1);
  });

  it('handles zero input and vertical-dominated routes', () => {
    expect(estimateMovingTime({ ...hiking, distanceM: 0, ascentM: 0, descentM: 0 }).movingMin).toBe(0);
    const steep = estimateMovingTime({ ...hiking, distanceM: 1000, ascentM: 900, descentM: 0 });
    expect(steep.movingMin).toBe(180 + 7.5); // vertical 180 min dominates, + half of 15 min horizontal
  });

  it('rejects invalid input', () => {
    expect(() => estimateMovingTime({ ...hiking, distanceM: -1, ascentM: 0, descentM: 0 })).toThrow(TrailPackError);
    expect(() => estimateMovingTime({ ...hiking, distanceM: Number.NaN, ascentM: 0, descentM: 0 })).toThrow(TrailPackError);
    expect(() => estimateMovingTime({ ...hiking, paceKmh: 0, distanceM: 1, ascentM: 0, descentM: 0 })).toThrow(TrailPackError);
  });
});

describe('estimateMovingTime – cycling', () => {
  it('gravel, moderate, trail: 40 km at 16 km/h + 400 m at 500 m/h = 198 min', () => {
    const res = estimateMovingTime({ distanceM: 40000, ascentM: 400, descentM: 400, activity: 'gravel', fitness: 'moderate', terrain: 'trail' });
    expect(res.model).toBe('cycling_vam');
    expect(res.movingMin).toBe(198);
  });

  it('is slower on rough terrain and for low fitness', () => {
    const base = { distanceM: 40000, ascentM: 400, descentM: 400, activity: 'mtb' as const };
    const fit = estimateMovingTime({ ...base, fitness: 'excellent', terrain: 'trail' }).movingMin;
    const unfit = estimateMovingTime({ ...base, fitness: 'low', terrain: 'rough' }).movingMin;
    expect(unfit).toBeGreaterThan(fit * 1.5);
  });
});

describe('estimateTotalTime', () => {
  it('adds breaks per hour', () => {
    expect(estimateTotalTime(252, 10)).toEqual({ movingMin: 252, breakMin: 42, totalMin: 294 });
    expect(estimateTotalTime(0, 10).totalMin).toBe(0);
  });
  it('rejects invalid values', () => {
    expect(() => estimateTotalTime(-5, 10)).toThrow(TrailPackError);
    expect(() => estimateTotalTime(60, 90)).toThrow(TrailPackError);
  });
});

describe('passTimes', () => {
  const start = Date.UTC(2026, 5, 21, 6, 0, 0);

  it('ends at start + total time and is monotonic', () => {
    const line = eqLine(11);
    const times = passTimes(line, hiking, start, 10);
    expect(times).toHaveLength(11);
    expect(times[0]).toBe(start);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    const moving = cumulativeMovingMinutes(line, hiking).at(-1)!;
    const total = estimateTotalTime(moving, 10).totalMin;
    expect((times.at(-1)! - start) / 60000).toBeCloseTo(total, 0);
    // 11.12 km at 4 km/h = 166.8 min moving, +10 min per hour
    expect(moving).toBeCloseTo(166.8, 0);
  });

  it('spends more time on steep climbs than on flat ground', () => {
    // first half climbs 500 m, second half flat
    const line = eqLine(11, [0, 100, 200, 300, 400, 500, 500, 500, 500, 500, 500]);
    const times = passTimes(line, hiking, start, 0);
    const mid = times[5]! - start;
    const end = times[10]! - start;
    expect(mid / end).toBeGreaterThan(0.6);
  });

  it('handles degenerate lines', () => {
    expect(passTimes([], hiking, start, 10)).toEqual([]);
    expect(passTimes([[0, 0]], hiking, start, 10)).toEqual([start]);
    expect(() => passTimes(eqLine(3), hiking, Number.NaN, 10)).toThrow(TrailPackError);
  });
});

describe('splitIntoStages', () => {
  const line = eqLine(11);
  const lonLat = (idx: number, dLat = 0) => ({ lat: dLat, lon: idx * 0.01 });

  it('balances a flat line into equal stages and ends at the route end', () => {
    const stages = splitIntoStages(line, { days: 2, timeParams: hiking });
    expect(stages).toHaveLength(2);
    expect(stages[0]!.fromIdx).toBe(0);
    expect(stages[0]!.toIdx).toBe(5);
    expect(stages[1]!.fromIdx).toBe(5);
    expect(stages[1]!.toIdx).toBe(10);
    expect(stages[0]!.distanceM + stages[1]!.distanceM).toBeCloseTo(11119.5, -1);
    expect(stages[0]!.movingMin).toBeGreaterThan(0);
    expect(stages[0]!.exceedsLimits).toEqual([]);
  });

  it('snaps to the best legal anchor and never to prohibited ones', () => {
    const stages = splitIntoStages(line, {
      days: 2,
      timeParams: hiking,
      anchors: [
        { id: 'bad', ...lonLat(5), kind: 'campsite', legalStatus: 'prohibited' },
        { id: 'unv', ...lonLat(5, 0.0005), kind: 'campsite', legalStatus: 'unverified' },
        { id: 'ok', ...lonLat(5, 0.001), kind: 'campsite', legalStatus: 'verified_allowed' },
      ],
    });
    expect(stages[0]!.endAnchorId).toBe('ok');
    expect(stages[0]!.endAnchorDistanceM).toBeGreaterThan(100);
    expect(stages[1]!.endAnchorId).toBeUndefined();
  });

  it('ignores anchors outside the snap radius and prohibited-only anchors', () => {
    const stages = splitIntoStages(line, {
      days: 2,
      timeParams: hiking,
      anchors: [
        { id: 'far', ...lonLat(5, 0.05), kind: 'shelter', legalStatus: 'verified_allowed' },
        { id: 'bad', ...lonLat(4), kind: 'campsite', legalStatus: 'prohibited' },
      ],
    });
    expect(stages[0]!.endAnchorId).toBeUndefined();
    expect(stages[0]!.toIdx).toBe(5);
  });

  it('uses a conditional anchor slightly off the ideal split', () => {
    const stages = splitIntoStages(line, {
      days: 2,
      timeParams: hiking,
      anchors: [{ id: 'c', ...lonLat(4), kind: 'shelter', legalStatus: 'conditional' }],
    });
    expect(stages[0]!.toIdx).toBe(4);
    expect(stages[0]!.endAnchorId).toBe('c');
  });

  it('reports exceeded limits in Czech', () => {
    const stages = splitIntoStages(line, { days: 2, timeParams: hiking, maxDailyDistanceM: 5000, maxDailyAscentM: 10 });
    expect(stages[0]!.exceedsLimits.join(' ')).toContain('Denní vzdálenost');
    const hilly = splitIntoStages(eqLine(11, [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]), { days: 2, timeParams: hiking, maxDailyAscentM: 300 });
    expect(hilly[0]!.exceedsLimits.join(' ')).toContain('Denní stoupání');
  });

  it('rejects impossible requests', () => {
    expect(() => splitIntoStages(line, { days: 0, timeParams: hiking })).toThrow(TrailPackError);
    expect(() => splitIntoStages([[0, 0]], { days: 1, timeParams: hiking })).toThrow(TrailPackError);
    expect(() => splitIntoStages(eqLine(3), { days: 5, timeParams: hiking })).toThrow(TrailPackError);
  });

  it('single stage covers the whole line', () => {
    const s = splitIntoStages(line, { days: 1, timeParams: hiking });
    expect(s).toHaveLength(1);
    expect(s[0]!.toIdx).toBe(10);
  });
});

describe('suggestDayCount', () => {
  it('returns 1 day for a short easy route', () => {
    expect(suggestDayCount(10000, 100, 20000, 1200, hiking)).toBe(1);
  });
  it('increases the day count until the daily moving time fits (60 km, +3000 m -> 4 days)', () => {
    expect(suggestDayCount(60000, 3000, 20000, 1200, hiking)).toBe(4);
  });
  it('rejects invalid limits', () => {
    expect(() => suggestDayCount(1000, 0, 0, 1200, hiking)).toThrow(TrailPackError);
  });
});
