import { describe, expect, it } from 'vitest';
import { TrailPackError } from '@trailpack/shared';
import type { ProfilePoint } from '../src/elevation';
import { daylightMinutes, sunTimes } from '../src/sun';
import { findSteepSections, rateDifficulty } from '../src/difficulty';
import { buildDaySchedule } from '../src/schedule';
import type { DayScheduleInput } from '../src/schedule';

const utcMinutes = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();

describe('sunTimes', () => {
  it('Prague summer solstice: sunrise ~02:52 UTC, sunset ~19:15 UTC (±4 min)', () => {
    const t = sunTimes('2026-06-21', 50.0755, 14.4378);
    expect(t.sunrise).not.toBeNull();
    expect(Math.abs(utcMinutes(t.sunrise!) - (2 * 60 + 52))).toBeLessThanOrEqual(4);
    expect(Math.abs(utcMinutes(t.sunset!) - (19 * 60 + 15))).toBeLessThanOrEqual(4);
    expect(t.civilDawn!.getTime()).toBeLessThan(t.sunrise!.getTime());
    expect(t.civilDusk!.getTime()).toBeGreaterThan(t.sunset!.getTime());
    expect(t.solarNoon.getUTCHours()).toBe(11);
  });

  it('Prague winter solstice has ~8 h of daylight', () => {
    const m = daylightMinutes('2025-12-21', 50.0755, 14.4378);
    expect(m).toBeGreaterThan(8 * 60);
    expect(m).toBeLessThan(8 * 60 + 10);
  });

  it('equator at the equinox has ~12 h of daylight', () => {
    expect(Math.abs(daylightMinutes('2026-03-20', 0, 0) - 727)).toBeLessThanOrEqual(6);
  });

  it('returns null / 1440 / 0 for polar day and night', () => {
    const day = sunTimes('2026-06-21', 69.65, 18.96);
    expect(day.sunrise).toBeNull();
    expect(day.sunset).toBeNull();
    expect(daylightMinutes('2026-06-21', 69.65, 18.96)).toBe(1440);
    const night = sunTimes('2025-12-21', 69.65, 18.96);
    expect(night.sunrise).toBeNull();
    expect(daylightMinutes('2025-12-21', 69.65, 18.96)).toBe(0);
  });

  it('rejects invalid input', () => {
    expect(() => sunTimes('21.6.2026', 50, 14)).toThrow(TrailPackError);
    expect(() => sunTimes('2026-02-30', 50, 14)).toThrow(TrailPackError);
    expect(() => sunTimes('2026-06-21', 95, 14)).toThrow(TrailPackError);
  });
});

describe('rateDifficulty', () => {
  it('rates a short flat walk as easy', () => {
    const r = rateDifficulty({ distanceM: 5000, ascentM: 50, movingMin: 60, activity: 'hiking' });
    expect(r.level).toBe('easy');
    expect(r.score).toBeLessThan(20);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('rates a long scrambling day as extreme with Czech reasons', () => {
    const r = rateDifficulty({ distanceM: 40000, ascentM: 3500, movingMin: 700, activity: 'hiking', terrain: 'scramble', maxGradePct: 45 });
    expect(r.level).toBe('extreme');
    expect(r.score).toBe(100);
    expect(r.reasons.join(' ')).toContain('Terén');
  });

  it('is monotonic in ascent and gives a middle level for a typical day hike', () => {
    const base = { distanceM: 18000, movingMin: 300, activity: 'hiking' as const };
    const lo = rateDifficulty({ ...base, ascentM: 200 });
    const hi = rateDifficulty({ ...base, ascentM: 1200 });
    expect(hi.score).toBeGreaterThan(lo.score);
    expect(['moderate', 'hard']).toContain(hi.level);
  });

  it('is more lenient for cycling and validates input', () => {
    const input = { distanceM: 60000, ascentM: 1500, movingMin: 360 };
    expect(rateDifficulty({ ...input, activity: 'gravel' }).score).toBeLessThan(rateDifficulty({ ...input, activity: 'hiking' }).score);
    expect(() => rateDifficulty({ distanceM: -1, ascentM: 0, movingMin: 1, activity: 'hiking' })).toThrow(TrailPackError);
  });
});

describe('findSteepSections', () => {
  const pt = (d: number, gradePct: number, idx: number): ProfilePoint => ({ d, ele: 0, lat: 0, lon: 0, gradePct, idx });
  const profile = [pt(0, 2, 0), pt(100, 5, 1), pt(200, 22, 2), pt(300, 28, 3), pt(400, 3, 4), pt(500, -25, 5), pt(600, -30, 6), pt(700, -2, 7), pt(800, 21, 8)];

  it('finds ascending and descending runs separately', () => {
    const s = findSteepSections(profile, 20);
    expect(s).toHaveLength(3);
    expect(s[0]).toEqual({ fromD: 100, toD: 300, maxGradePct: 28, idxFrom: 1, idxTo: 3 });
    expect(s[1]).toEqual({ fromD: 400, toD: 600, maxGradePct: -30, idxFrom: 4, idxTo: 6 });
    expect(s[2]!.idxTo).toBe(8);
  });

  it('returns nothing for gentle profiles or empty input and rejects bad thresholds', () => {
    expect(findSteepSections(profile, 50)).toEqual([]);
    expect(findSteepSections([], 10)).toEqual([]);
    expect(() => findSteepSections(profile, 0)).toThrow(TrailPackError);
  });
});

describe('buildDaySchedule', () => {
  const base: DayScheduleInput = {
    date: '2026-06-21',
    startTime: '08:00',
    movingMin: 480,
    breakMin: 80,
    sunsetIso: '2026-06-21T19:15:00Z',
    timezoneOffsetMin: 120,
    campAllowed: true,
    sleepType: 'tent',
  };

  it('builds a full timeline with arrival 17:20 and a 235 min sunset reserve', () => {
    const s = buildDaySchedule(base);
    expect(s.arrivalTime).toBe('17:20');
    expect(s.sunsetReserveMin).toBe(235);
    expect(s.advisories).toEqual([]);
    const kinds = s.items.map((i) => i.kind);
    expect(kinds.slice(0, 3)).toEqual(['wake', 'breakfast', 'depart']);
    expect(s.items[0]!.time).toBe('07:00');
    expect(kinds).toContain('lunch');
    expect(kinds).toContain('camp_setup');
    expect(kinds.at(-1)).toBe('sleep');
    // lunch: 4 h of walking + 3 short breaks of 8.33 min before it
    expect(s.items.find((i) => i.kind === 'lunch')!.time).toBe('12:25');
    expect(s.items.find((i) => i.kind === 'camp_setup')!.time).toBe('17:20');
  });

  it('warns when arriving less than 60 min before sunset', () => {
    const s = buildDaySchedule({ ...base, movingMin: 600, breakMin: 100 });
    // arrival 08:00 + 700 min = 19:40 -> after sunset 21:15? no, 95 min before
    expect(s.sunsetReserveMin).toBe(95);
    const late = buildDaySchedule({ ...base, movingMin: 700, breakMin: 100 });
    // arrival 08:00 + 800 = 21:20, sunset 21:15 -> 5 min after
    expect(late.sunsetReserveMin).toBe(-5);
    expect(late.advisories[0]!.code).toBe('arrival_after_sunset');
    expect(late.advisories[0]!.severity).toBe('danger');
    const near = buildDaySchedule({ ...base, movingMin: 650, breakMin: 100 });
    // arrival 20:30 -> 45 min before sunset
    expect(near.sunsetReserveMin).toBe(45);
    expect(near.advisories[0]!.code).toBe('arrival_near_sunset');
    expect(near.advisories[0]!.severity).toBe('warning');
  });

  it('omits camp setup and explains when camping is not allowed', () => {
    const s = buildDaySchedule({ ...base, campAllowed: false });
    expect(s.items.some((i) => i.kind === 'camp_setup')).toBe(false);
    expect(s.advisories.map((a) => a.code)).toContain('camp_not_allowed');
  });

  it('lays out segments and water stops in order', () => {
    const s = buildDaySchedule({
      ...base,
      movingMin: 240,
      breakMin: 0,
      segments: [
        { label: 'Úsek 1', movingMin: 120 },
        { label: 'Úsek 2', movingMin: 120 },
      ],
      waterStops: [{ label: 'Pramen', atMin: 90 }],
    });
    const mid = s.items.filter((i) => ['segment', 'water'].includes(i.kind)).map((i) => `${i.time} ${i.label}`);
    expect(mid).toEqual(['08:00 Úsek 1', '09:30 Pramen', '10:00 Úsek 2']);
    expect(s.arrivalTime).toBe('12:00');
  });

  it('works without sunset information and validates input', () => {
    const s = buildDaySchedule({ ...base, sunsetIso: null });
    expect(s.sunsetReserveMin).toBeNull();
    expect(() => buildDaySchedule({ ...base, startTime: '8:00' })).toThrow(TrailPackError);
    expect(() => buildDaySchedule({ ...base, movingMin: -1 })).toThrow(TrailPackError);
    expect(() => buildDaySchedule({ ...base, sunsetIso: 'nonsense' })).toThrow(TrailPackError);
  });
});
