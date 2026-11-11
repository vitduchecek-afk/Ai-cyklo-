/**
 * Live GPS tracking: a recorder with quality filtering, pause handling and
 * statistics, and a route follower for off-route detection and ETA.
 * Both classes are pure state machines driven by supplied timestamps (no
 * clock access), serialisable so a recording survives an app restart.
 */
import type { LatLon, Position, TrackPoint } from '@trailpack/shared';
import { TrailPackError } from '@trailpack/shared';
import { bearing, cumulativeDistances, haversine, nearestPointOnLine, pointAlong } from './geo';
import { invalid, requireNumber } from './internal';

export interface TrackRecorderOptions {
  /** Fixes with worse horizontal accuracy (m) are rejected. Default 30. */
  maxAccuracyM?: number;
  /** Minimum movement between recorded points (m); smaller moves are jitter. Default 2. */
  minDistanceM?: number;
  /** Speeds above this (m/s) are treated as GPS jumps. Default 25. */
  maxSpeedMs?: number;
  /** Auto-pause when slower than this speed (m/s). Default 0.5. */
  autoPauseSpeedMs?: number;
  /** ... for longer than this many seconds. Default 60. */
  autoPauseAfterS?: number;
  /** Enable auto-pause. Default true. */
  autoPause?: boolean;
  /** GPS considered lost after this many seconds without a fix. Default 30. */
  gpsLostAfterS?: number;
  /** Elevation hysteresis for ascent/descent, m. Default 5. */
  ascentThresholdM?: number;
}

type ResolvedOptions = Required<TrackRecorderOptions>;

const DEFAULTS: ResolvedOptions = {
  maxAccuracyM: 30,
  minDistanceM: 2,
  maxSpeedMs: 25,
  autoPauseSpeedMs: 0.5,
  autoPauseAfterS: 60,
  autoPause: true,
  gpsLostAfterS: 30,
  ascentThresholdM: 5,
};

export type RejectReason = 'no_time' | 'invalid' | 'accuracy' | 'time_order' | 'jitter' | 'speed' | 'paused' | 'finished';

export interface AddPointResult {
  accepted: boolean;
  reason?: RejectReason;
}

export type RecorderStatus = 'idle' | 'recording' | 'paused' | 'finished';

export interface TrackStats {
  distanceM: number;
  /** Time spent moving (excluding auto-pauses and manual pauses), s. */
  movingTimeS: number;
  /** Recording time from start (excluding manual pauses), s. */
  elapsedTimeS: number;
  ascentM: number;
  descentM: number;
  avgSpeedKmh: number;
  currentSpeedKmh: number;
  maxSpeedKmh: number;
  lastPoint: TrackPoint | null;
  /** No fix for more than `gpsLostAfterS` seconds. */
  gpsLost: boolean;
  status: RecorderStatus;
  /** Currently auto-paused (standing still). */
  autoPaused: boolean;
}

/** Serialised recorder state. */
export interface TrackRecorderState {
  version: 1;
  options: ResolvedOptions;
  status: RecorderStatus;
  startMs: number | null;
  endMs: number | null;
  pausedTotalMs: number;
  pauseStartMs: number | null;
  points: TrackPoint[];
  distanceM: number;
  movingS: number;
  slowRunS: number;
  ascentM: number;
  descentM: number;
  eleRef: number | null;
  maxSpeedMs: number;
  speedMs: number;
  prevFix: TrackPoint | null;
  lastFixMs: number | null;
  rejectedStreak: number;
}

/** Records a GPS track with filtering and live statistics. */
export class TrackRecorder {
  private s: TrackRecorderState;

  constructor(options: TrackRecorderOptions = {}) {
    const o: ResolvedOptions = { ...DEFAULTS, ...stripUndefined(options) };
    requireNumber('maxAccuracyM', o.maxAccuracyM, 1);
    requireNumber('minDistanceM', o.minDistanceM, 0);
    requireNumber('maxSpeedMs', o.maxSpeedMs, 1);
    requireNumber('autoPauseSpeedMs', o.autoPauseSpeedMs, 0);
    requireNumber('autoPauseAfterS', o.autoPauseAfterS, 0);
    requireNumber('gpsLostAfterS', o.gpsLostAfterS, 1);
    requireNumber('ascentThresholdM', o.ascentThresholdM, 0);
    this.s = {
      version: 1,
      options: o,
      status: 'idle',
      startMs: null,
      endMs: null,
      pausedTotalMs: 0,
      pauseStartMs: null,
      points: [],
      distanceM: 0,
      movingS: 0,
      slowRunS: 0,
      ascentM: 0,
      descentM: 0,
      eleRef: null,
      maxSpeedMs: 0,
      speedMs: 0,
      prevFix: null,
      lastFixMs: null,
      rejectedStreak: 0,
    };
  }

  /** Start recording at `nowMs` (epoch ms). Starting twice is a no-op. */
  start(nowMs: number): void {
    if (this.s.status !== 'idle') return;
    this.s.status = 'recording';
    this.s.startMs = nowMs;
  }

  /** Manually pause. Fixes during a pause are ignored. */
  pause(nowMs: number): void {
    if (this.s.status !== 'recording') return;
    this.s.status = 'paused';
    this.s.pauseStartMs = nowMs;
    this.flushSlow();
    this.s.speedMs = 0;
  }

  /** Resume after a manual pause; the first fix afterwards starts a new segment (movement during the pause is not counted). */
  resume(nowMs: number): void {
    if (this.s.status !== 'paused') return;
    this.s.pausedTotalMs += Math.max(0, nowMs - (this.s.pauseStartMs ?? nowMs));
    this.s.pauseStartMs = null;
    this.s.status = 'recording';
    this.s.prevFix = null;
    this.s.rejectedStreak = 0;
  }

  /** Finish the recording; statistics are frozen at `nowMs`. */
  finish(nowMs: number): void {
    if (this.s.status === 'finished') return;
    if (this.s.status === 'paused') this.resume(nowMs);
    this.flushSlow();
    this.s.status = 'finished';
    this.s.endMs = nowMs;
    this.s.speedMs = 0;
  }

  /**
   * Feed a GPS fix (must carry `time`, epoch ms). The recorder starts
   * automatically on the first fix.
   */
  addPoint(p: TrackPoint): AddPointResult {
    const s = this.s;
    const o = s.options;
    if (s.status === 'finished') return { accepted: false, reason: 'finished' };
    if (typeof p.time !== 'number' || !Number.isFinite(p.time)) return { accepted: false, reason: 'no_time' };
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return { accepted: false, reason: 'invalid' };
    if (s.status === 'idle') this.start(p.time);
    if (s.lastFixMs !== null && p.time <= s.lastFixMs) return { accepted: false, reason: 'time_order' };
    s.lastFixMs = p.time;
    if (s.status === 'paused') return { accepted: false, reason: 'paused' };
    if (p.accuracy !== undefined && p.accuracy > o.maxAccuracyM) return { accepted: false, reason: 'accuracy' };

    const prev = s.prevFix;
    const last = s.points[s.points.length - 1];
    if (!prev || !last) {
      this.accept(p, 0);
      s.prevFix = p;
      return { accepted: true };
    }
    const dt = (p.time - (prev.time as number)) / 1000;
    const dFix = haversine(prev, p);
    const speed = dt > 0 ? dFix / dt : 0;
    // Implausible jump: reject, but re-sync after a streak of consistent rejections (e.g. after a tunnel).
    if (speed > o.maxSpeedMs) {
      s.rejectedStreak++;
      if (s.rejectedStreak < 3) return { accepted: false, reason: 'speed' };
      s.rejectedStreak = 0;
      this.flushSlow();
      this.accept(p, 0);
      s.prevFix = p;
      return { accepted: true };
    }
    s.rejectedStreak = 0;

    // Speed bookkeeping uses consecutive fixes (including jitter-filtered ones).
    s.speedMs = s.speedMs === 0 ? speed : 0.5 * s.speedMs + 0.5 * speed;
    this.trackMoving(speed, dt);
    s.prevFix = p;

    const dLast = haversine(last, p);
    const jitterM = Math.max(o.minDistanceM, Math.min((p.accuracy ?? 0) * 0.5, 10));
    if (dLast < jitterM) return { accepted: false, reason: 'jitter' };
    this.accept(p, dLast);
    if (s.speedMs > s.maxSpeedMs) s.maxSpeedMs = s.speedMs;
    return { accepted: true };
  }

  private accept(p: TrackPoint, distM: number): void {
    const s = this.s;
    s.points.push({ ...p });
    s.distanceM += distM;
    if (p.ele !== undefined && Number.isFinite(p.ele)) {
      if (s.eleRef === null) s.eleRef = p.ele;
      else {
        const diff = p.ele - s.eleRef;
        if (Math.abs(diff) >= s.options.ascentThresholdM) {
          if (diff > 0) s.ascentM += diff;
          else s.descentM -= diff;
          s.eleRef = p.ele;
        }
      }
    }
  }

  private trackMoving(speed: number, dt: number): void {
    const s = this.s;
    const o = s.options;
    if (!o.autoPause) {
      s.movingS += dt;
      return;
    }
    if (speed < o.autoPauseSpeedMs) {
      s.slowRunS += dt;
    } else {
      this.flushSlow();
      s.movingS += dt;
    }
  }

  /** Count a finished slow stretch as moving time only if it was shorter than the auto-pause limit. */
  private flushSlow(): void {
    const s = this.s;
    if (s.slowRunS > 0 && s.slowRunS <= s.options.autoPauseAfterS) s.movingS += s.slowRunS;
    s.slowRunS = 0;
  }

  /** Current state of the recorder. */
  get status(): RecorderStatus {
    return this.s.status;
  }

  /** Recorded (accepted) points. */
  getPoints(): readonly TrackPoint[] {
    return this.s.points;
  }

  /**
   * Statistics at `nowMs` (epoch ms). `gpsLost` is true when no fix has
   * arrived for more than `gpsLostAfterS` seconds while recording.
   */
  getStats(nowMs: number): TrackStats {
    const s = this.s;
    const o = s.options;
    const end = s.endMs ?? nowMs;
    const pausedMs = s.pausedTotalMs + (s.pauseStartMs !== null ? Math.max(0, end - s.pauseStartMs) : 0);
    const elapsedS = s.startMs === null ? 0 : Math.max(0, (end - s.startMs - pausedMs) / 1000);
    const pendingSlow = s.slowRunS > 0 && s.slowRunS <= o.autoPauseAfterS ? s.slowRunS : 0;
    const movingS = Math.min(elapsedS, s.movingS + pendingSlow);
    const recording = s.status === 'recording';
    const gpsLost = recording && (s.lastFixMs === null ? s.startMs !== null && nowMs - s.startMs > o.gpsLostAfterS * 1000 : nowMs - s.lastFixMs > o.gpsLostAfterS * 1000);
    const autoPaused = recording && o.autoPause && s.slowRunS > o.autoPauseAfterS;
    const showSpeed = recording && !gpsLost && !autoPaused;
    return {
      distanceM: s.distanceM,
      movingTimeS: movingS,
      elapsedTimeS: elapsedS,
      ascentM: s.ascentM,
      descentM: s.descentM,
      avgSpeedKmh: movingS > 0 ? (s.distanceM / movingS) * 3.6 : 0,
      currentSpeedKmh: showSpeed ? s.speedMs * 3.6 : 0,
      maxSpeedKmh: s.maxSpeedMs * 3.6,
      lastPoint: s.points[s.points.length - 1] ?? null,
      gpsLost,
      status: s.status,
      autoPaused,
    };
  }

  /** Serialise the full state (JSON-safe) so a recording can survive an app restart. */
  toJSON(): TrackRecorderState {
    return JSON.parse(JSON.stringify(this.s)) as TrackRecorderState;
  }

  /** Restore a recorder from {@link TrackRecorder.toJSON} output. Throws `invalid_input` for malformed data. */
  static fromJSON(data: unknown): TrackRecorder {
    if (!data || typeof data !== 'object') invalid('Neplatná uložená data nahrávání.');
    const d = data as Partial<TrackRecorderState>;
    if (d.version !== 1 || !Array.isArray(d.points) || typeof d.status !== 'string' || !d.options) {
      throw new TrailPackError('invalid_input', 'Neplatná nebo nepodporovaná uložená data nahrávání.');
    }
    const rec = new TrackRecorder(d.options);
    rec.s = { ...rec.s, ...(JSON.parse(JSON.stringify(d)) as TrackRecorderState) };
    return rec;
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---------------------------------------------------------------------------
// Route following
// ---------------------------------------------------------------------------

export interface RouteFollowerOptions {
  /** Distance from the route beyond which a fix counts as off-route, m. Default 60. */
  offRouteThresholdM?: number;
  /** Consecutive off-route fixes needed to report `offRoute`. Default 3. */
  offRouteFixes?: number;
  /** Speed used for the ETA until enough progress data exists, m/s. Default 1.1 (≈ 4 km/h). */
  expectedSpeedMs?: number;
}

export interface FollowUpdate {
  /** True after `offRouteFixes` consecutive fixes farther than the threshold. */
  offRoute: boolean;
  /** Distance of the fix from the route, m. */
  distanceToRouteM: number;
  /** Distance along the route of the snapped position, m. */
  alongM: number;
  remainingM: number;
  progressPct: number;
  /** Compass bearing (degrees) towards the route ~30 m ahead; null at the end of the route. */
  nextBearingDeg: number | null;
  /** Estimated arrival, epoch ms; null when the fix has no time. */
  etaEpochMs: number | null;
}

interface Sample {
  t: number;
  along: number;
}

/** Follows a planned route: off-route detection, progress and ETA. */
export class RouteFollower {
  private readonly line: readonly Position[];
  private readonly cum: number[];
  private readonly thresholdM: number;
  private readonly fixes: number;
  private readonly expectedSpeed: number;
  private offCount = 0;
  private lastAlong: number | null = null;
  private samples: Sample[] = [];

  constructor(routeGeometry: readonly Position[], opts: RouteFollowerOptions = {}) {
    if (routeGeometry.length < 2) invalid('Trasa musí mít alespoň dva body.');
    this.line = routeGeometry;
    this.cum = cumulativeDistances(routeGeometry);
    this.thresholdM = requireNumber('offRouteThresholdM', opts.offRouteThresholdM ?? 60, 1, 10000);
    this.fixes = requireNumber('offRouteFixes', opts.offRouteFixes ?? 3, 1, 100);
    this.expectedSpeed = requireNumber('expectedSpeedMs', opts.expectedSpeedMs ?? 1.1, 0.1, 50);
  }

  /** Total route length, m. */
  get totalM(): number {
    return this.cum[this.cum.length - 1]!;
  }

  /** Forget progress (e.g. when restarting the navigation). */
  reset(): void {
    this.offCount = 0;
    this.lastAlong = null;
    this.samples = [];
  }

  /** Process a GPS fix. Pass `point.time` (epoch ms) to get an ETA. */
  update(point: Pick<TrackPoint, 'lat' | 'lon' | 'time'>): FollowUpdate {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) invalid('Neplatná poloha.');
    const here: LatLon = { lat: point.lat, lon: point.lon };
    const total = this.totalM;
    const snap = this.snap(here);
    const dist = snap.distanceM;
    if (dist > this.thresholdM) this.offCount++;
    else this.offCount = 0;
    const offRoute = this.offCount >= this.fixes;
    if (dist <= this.thresholdM) this.lastAlong = snap.alongM;

    const along = snap.alongM;
    const remaining = Math.max(0, total - along);
    let eta: number | null = null;
    if (typeof point.time === 'number' && Number.isFinite(point.time)) {
      if (dist <= this.thresholdM) {
        this.samples.push({ t: point.time, along });
        const horizon = point.time - 10 * 60000;
        while (this.samples.length > 2 && this.samples[1]!.t < horizon) this.samples.shift();
      }
      eta = point.time + (remaining / this.speedEstimate()) * 1000;
    }
    const ahead = along + 30;
    const nextBearing = remaining < 5 ? null : bearing(snap.point, pointAlong(this.line, Math.min(total, ahead), this.cum).point);
    return {
      offRoute,
      distanceToRouteM: dist,
      alongM: along,
      remainingM: remaining,
      progressPct: total > 0 ? Math.min(100, Math.max(0, (along / total) * 100)) : 100,
      nextBearingDeg: nextBearing,
      etaEpochMs: eta,
    };
  }

  /** Snap to the route, preferring the stretch just ahead of the previous position (handles loops and out-and-back routes). */
  private snap(here: LatLon): { point: LatLon; distanceM: number; alongM: number } {
    if (this.lastAlong !== null) {
      const from = this.lastAlong - 300;
      const to = this.lastAlong + 3000;
      let lo = 0;
      while (lo < this.cum.length - 2 && this.cum[lo + 1]! < from) lo++;
      let hi = lo + 1;
      while (hi < this.cum.length - 1 && this.cum[hi]! < to) hi++;
      const sub = this.line.slice(lo, hi + 1);
      if (sub.length >= 2) {
        const local = nearestPointOnLine(sub, here);
        if (local.distanceM <= this.thresholdM) return { point: local.point, distanceM: local.distanceM, alongM: this.cum[lo]! + local.alongM };
      }
    }
    const g = nearestPointOnLine(this.line, here, this.cum);
    return { point: g.point, distanceM: g.distanceM, alongM: g.alongM };
  }

  private speedEstimate(): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (first && last && last.t - first.t >= 60000 && last.along - first.along >= 50) {
      return Math.max(0.3, ((last.along - first.along) / (last.t - first.t)) * 1000);
    }
    return this.expectedSpeed;
  }
}

