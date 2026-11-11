import { describe, expect, it } from 'vitest';
import type { Position, TrackPoint } from '@trailpack/shared';
import { TrailPackError } from '@trailpack/shared';
import { destinationPoint } from '../src/geo';
import { RouteFollower, TrackRecorder } from '../src/tracking';

const T0 = Date.UTC(2026, 5, 21, 6, 0, 0);

/** Fix `i` of a walk east along the equator, `stepM` metres every `dtS` seconds. */
function walkFix(i: number, stepM = 7, dtS = 5, extra: Partial<TrackPoint> = {}): TrackPoint {
  const p = destinationPoint({ lat: 0, lon: 0 }, 90, i * stepM);
  return { lat: p.lat, lon: p.lon, time: T0 + i * dtS * 1000, ...extra };
}

describe('TrackRecorder', () => {
  it('accumulates distance, moving time and speed for a steady walk', () => {
    const rec = new TrackRecorder();
    for (let i = 0; i <= 60; i++) expect(rec.addPoint(walkFix(i)).accepted).toBe(true);
    const s = rec.getStats(T0 + 300_000);
    expect(s.distanceM).toBeCloseTo(420, 0);
    expect(s.movingTimeS).toBe(300);
    expect(s.elapsedTimeS).toBe(300);
    expect(s.avgSpeedKmh).toBeCloseTo(5.04, 1);
    expect(s.currentSpeedKmh).toBeCloseTo(5.04, 1);
    expect(s.maxSpeedKmh).toBeCloseTo(5.04, 1);
    expect(s.gpsLost).toBe(false);
    expect(s.autoPaused).toBe(false);
    expect(s.status).toBe('recording');
    expect(rec.getPoints()).toHaveLength(61);
  });

  it('rejects poor accuracy, jitter, implausible jumps, bad time and invalid input', () => {
    const rec = new TrackRecorder();
    expect(rec.addPoint(walkFix(0)).accepted).toBe(true);
    expect(rec.addPoint(walkFix(1, 7, 5, { accuracy: 100 }))).toEqual({ accepted: false, reason: 'accuracy' });
    expect(rec.addPoint({ ...walkFix(0.1, 7), time: T0 + 6000 })).toEqual({ accepted: false, reason: 'jitter' });
    const jump = { ...walkFix(2), lon: 0.05 }; // ~5.5 km in 5 s
    expect(rec.addPoint({ ...jump, time: T0 + 10_000 })).toEqual({ accepted: false, reason: 'speed' });
    expect(rec.addPoint({ ...walkFix(3), time: T0 + 4000 })).toEqual({ accepted: false, reason: 'time_order' });
    expect(rec.addPoint({ lat: 0, lon: 0 })).toEqual({ accepted: false, reason: 'no_time' });
    expect(rec.addPoint({ lat: 95, lon: 0, time: T0 + 99_000 })).toEqual({ accepted: false, reason: 'invalid' });
    expect(rec.getPoints()).toHaveLength(1);
  });

  it('re-syncs after repeated consistent jumps without counting the jump as distance', () => {
    const rec = new TrackRecorder();
    rec.addPoint(walkFix(0));
    const far = (n: number): TrackPoint => ({ lat: 0, lon: 0.05 + n * 0.00006, time: T0 + 5000 * (n + 1) });
    expect(rec.addPoint(far(0)).reason).toBe('speed');
    expect(rec.addPoint(far(1)).reason).toBe('speed');
    expect(rec.addPoint(far(2)).accepted).toBe(true);
    expect(rec.getStats(T0 + 20_000).distanceM).toBe(0);
  });

  it('auto-pauses after 60 s below 0.5 m/s and excludes that time from moving time', () => {
    const rec = new TrackRecorder();
    for (let i = 0; i <= 10; i++) rec.addPoint(walkFix(i));
    const here = walkFix(10);
    for (let k = 1; k <= 18; k++) rec.addPoint({ ...here, time: here.time! + k * 5000 }); // 90 s standing
    const standing = rec.getStats(here.time! + 90_000);
    expect(standing.autoPaused).toBe(true);
    expect(standing.currentSpeedKmh).toBe(0);
    expect(standing.movingTimeS).toBe(50);
    expect(standing.elapsedTimeS).toBe(140);
    // walking again
    const resume = destinationPoint({ lat: 0, lon: 0 }, 90, 10 * 7 + 7);
    rec.addPoint({ lat: resume.lat, lon: resume.lon, time: here.time! + 95_000 });
    const after = rec.getStats(here.time! + 95_000);
    expect(after.autoPaused).toBe(false);
    expect(after.movingTimeS).toBe(55);
  });

  it('keeps short stops (< 60 s) as moving time', () => {
    const rec = new TrackRecorder();
    for (let i = 0; i <= 10; i++) rec.addPoint(walkFix(i));
    const here = walkFix(10);
    for (let k = 1; k <= 6; k++) rec.addPoint({ ...here, time: here.time! + k * 5000 }); // 30 s
    const p = destinationPoint({ lat: 0, lon: 0 }, 90, 10 * 7 + 7);
    rec.addPoint({ lat: p.lat, lon: p.lon, time: here.time! + 35_000 });
    expect(rec.getStats(here.time! + 35_000).movingTimeS).toBe(85);
  });

  it('can disable auto-pause', () => {
    const rec = new TrackRecorder({ autoPause: false });
    rec.addPoint(walkFix(0));
    const here = walkFix(0);
    for (let k = 1; k <= 20; k++) rec.addPoint({ ...here, time: here.time! + k * 5000 });
    expect(rec.getStats(here.time! + 100_000).movingTimeS).toBe(100);
  });

  it('detects GPS loss after 30 s without a fix', () => {
    const rec = new TrackRecorder();
    for (let i = 0; i <= 5; i++) rec.addPoint(walkFix(i));
    const last = T0 + 25_000;
    expect(rec.getStats(last + 29_000).gpsLost).toBe(false);
    const lost = rec.getStats(last + 31_000);
    expect(lost.gpsLost).toBe(true);
    expect(lost.currentSpeedKmh).toBe(0);
  });

  it('manual pause ignores fixes, excludes paused time and does not count movement during the pause', () => {
    const rec = new TrackRecorder();
    for (let i = 0; i <= 4; i++) rec.addPoint(walkFix(i));
    rec.pause(T0 + 20_000);
    expect(rec.status).toBe('paused');
    expect(rec.addPoint(walkFix(5))).toEqual({ accepted: false, reason: 'paused' });
    rec.resume(T0 + 120_000);
    const before = rec.getStats(T0 + 120_000);
    expect(before.elapsedTimeS).toBe(20);
    expect(rec.addPoint(walkFix(30, 7, 5)).accepted).toBe(true); // far away, new segment
    expect(rec.getStats(T0 + 150_000).distanceM).toBeCloseTo(28, 0);
    rec.finish(T0 + 200_000);
    expect(rec.status).toBe('finished');
    expect(rec.addPoint(walkFix(40)).reason).toBe('finished');
    expect(rec.getStats(T0 + 999_999).elapsedTimeS).toBe(100);
  });

  it('counts ascent/descent with a 5 m threshold and ignores noise', () => {
    const climb = new TrackRecorder();
    for (let i = 0; i <= 20; i++) climb.addPoint(walkFix(i, 7, 5, { ele: 100 + i }));
    expect(climb.getStats(T0 + 100_000).ascentM).toBe(20);
    const noisy = new TrackRecorder();
    for (let i = 0; i <= 20; i++) noisy.addPoint(walkFix(i, 7, 5, { ele: 100 + (i % 2 ? 2 : -2) }));
    const n = noisy.getStats(T0 + 100_000);
    expect(n.ascentM).toBe(0);
    expect(n.descentM).toBe(0);
    const down = new TrackRecorder();
    for (let i = 0; i <= 10; i++) down.addPoint(walkFix(i, 7, 5, { ele: 200 - i }));
    expect(down.getStats(T0 + 50_000).descentM).toBe(10);
  });

  it('survives a restart via toJSON / fromJSON', () => {
    const rec = new TrackRecorder();
    for (let i = 0; i <= 20; i++) rec.addPoint(walkFix(i, 7, 5, { ele: 100 + i }));
    const restored = TrackRecorder.fromJSON(JSON.parse(JSON.stringify(rec.toJSON())));
    const now = T0 + 100_000;
    expect(restored.getStats(now)).toEqual(rec.getStats(now));
    for (let i = 21; i <= 30; i++) {
      rec.addPoint(walkFix(i, 7, 5, { ele: 100 + i }));
      restored.addPoint(walkFix(i, 7, 5, { ele: 100 + i }));
    }
    expect(restored.getStats(T0 + 150_000)).toEqual(rec.getStats(T0 + 150_000));
    expect(restored.getPoints()).toHaveLength(31);
  });

  it('rejects malformed saved data and invalid options', () => {
    expect(() => TrackRecorder.fromJSON(null)).toThrow(TrailPackError);
    expect(() => TrackRecorder.fromJSON({ version: 2 })).toThrow(TrailPackError);
    expect(() => new TrackRecorder({ maxAccuracyM: -5 })).toThrow(TrailPackError);
  });

  it('reports zero stats before any fix', () => {
    const s = new TrackRecorder().getStats(T0);
    expect(s).toMatchObject({ distanceM: 0, movingTimeS: 0, elapsedTimeS: 0, avgSpeedKmh: 0, lastPoint: null, gpsLost: false, status: 'idle' });
  });
});

describe('RouteFollower', () => {
  const route: Position[] = Array.from({ length: 21 }, (_, i) => [i * 0.001, 0] as Position); // ~2224 m east
  const at = (alongM: number, northM = 0, time?: number) => {
    const p = destinationPoint({ lat: 0, lon: 0 }, 90, alongM);
    const q = northM ? destinationPoint(p, 0, northM) : p;
    return { lat: q.lat, lon: q.lon, time };
  };

  it('reports progress, remaining distance, bearing and ETA on route', () => {
    const f = new RouteFollower(route, { offRouteThresholdM: 60 });
    const u = f.update(at(1112, 5, T0));
    expect(u.offRoute).toBe(false);
    expect(u.distanceToRouteM).toBeCloseTo(5, 0);
    expect(u.alongM).toBeCloseTo(1112, -1);
    expect(u.progressPct).toBeCloseTo(50, 0);
    expect(u.remainingM + u.alongM).toBeCloseTo(f.totalM, 3);
    expect(u.nextBearingDeg).toBeCloseTo(90, 0);
    // 1112 m remaining at the default 1.1 m/s
    expect(u.etaEpochMs! - T0).toBeCloseTo((u.remainingM / 1.1) * 1000, -2);
  });

  it('flags off-route only after 3 consecutive far fixes and resets when back on route', () => {
    const f = new RouteFollower(route, { offRouteThresholdM: 60 });
    expect(f.update(at(500, 200)).offRoute).toBe(false);
    expect(f.update(at(510, 200)).offRoute).toBe(false);
    const third = f.update(at(520, 200));
    expect(third.offRoute).toBe(true);
    expect(third.distanceToRouteM).toBeCloseTo(200, -1);
    expect(f.update(at(530, 10)).offRoute).toBe(false);
  });

  it('estimates speed from recent progress and returns null ETA without time', () => {
    const f = new RouteFollower(route);
    f.update(at(100, 0, T0));
    const u = f.update(at(400, 0, T0 + 100_000)); // 3 m/s
    expect(u.etaEpochMs! - (T0 + 100_000)).toBeCloseTo(((f.totalM - 400) / 3) * 1000, -3);
    expect(f.update(at(450)).etaEpochMs).toBeNull();
  });

  it('prefers the stretch ahead on out-and-back routes and handles the end', () => {
    const there: Position[] = [...route, ...[...route].reverse().slice(1)];
    const f = new RouteFollower(there);
    f.update(at(1500));
    const u = f.update(at(1600));
    expect(u.alongM).toBeCloseTo(1600, -1);
    const end = new RouteFollower(route).update(at(2224));
    expect(end.nextBearingDeg).toBeNull();
    expect(end.progressPct).toBeGreaterThan(99.9);
    expect(end.remainingM).toBeLessThan(5);
  });

  it('rejects invalid routes, options and positions', () => {
    expect(() => new RouteFollower([[0, 0]])).toThrow(TrailPackError);
    expect(() => new RouteFollower(route, { offRouteThresholdM: 0 })).toThrow(TrailPackError);
    expect(() => new RouteFollower(route).update({ lat: Number.NaN, lon: 0 })).toThrow(TrailPackError);
  });
});
