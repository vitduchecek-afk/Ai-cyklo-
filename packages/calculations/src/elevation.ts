/**
 * Elevation statistics. Raw GPS / DEM elevations are noisy; summing every
 * small up/down tick overestimates ascent dramatically. We therefore apply a
 * hysteresis threshold (default 3 m for DEM data, 5 m+ for GPS-only tracks).
 *
 * STABLE API – other packages depend on these signatures.
 */
import type { Position } from '@trailpack/shared';
import { cumulativeDistances, eleOf } from './geo';

export interface ElevationStats {
  ascentM: number;
  descentM: number;
  minEleM: number | undefined;
  maxEleM: number | undefined;
  startEleM: number | undefined;
  endEleM: number | undefined;
  /** true when every vertex had an elevation */
  complete: boolean;
}

/** Ascent/descent with hysteresis. Missing elevations are skipped. */
export function elevationStats(line: readonly Position[], thresholdM = 3): ElevationStats {
  let ascent = 0;
  let descent = 0;
  let min: number | undefined;
  let max: number | undefined;
  let ref: number | undefined;
  let first: number | undefined;
  let last: number | undefined;
  let complete = line.length > 0;
  for (const p of line) {
    const e = eleOf(p);
    if (e === undefined || !Number.isFinite(e)) {
      complete = false;
      continue;
    }
    if (first === undefined) first = e;
    last = e;
    if (min === undefined || e < min) min = e;
    if (max === undefined || e > max) max = e;
    if (ref === undefined) {
      ref = e;
      continue;
    }
    const diff = e - ref;
    if (diff >= thresholdM) {
      ascent += diff;
      ref = e;
    } else if (diff <= -thresholdM) {
      descent += -diff;
      ref = e;
    }
  }
  // account for the residual between the last reference and the final point
  if (ref !== undefined && last !== undefined) {
    const diff = last - ref;
    if (diff > 0) ascent += diff;
    else descent += -diff;
  }
  return { ascentM: ascent, descentM: descent, minEleM: min, maxEleM: max, startEleM: first, endEleM: last, complete };
}

/** Moving-average smoothing of elevations over a window in meters. */
export function smoothElevations(line: readonly Position[], windowM = 50): Position[] {
  const cum = cumulativeDistances(line);
  const half = windowM / 2;
  const out: Position[] = [];
  let lo = 0;
  let hi = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    while (hi < line.length && cum[hi]! - cum[i]! <= half) {
      const e = eleOf(line[hi]!);
      if (e !== undefined) {
        sum += e;
        count++;
      }
      hi++;
    }
    while (lo < i && cum[i]! - cum[lo]! > half) {
      const e = eleOf(line[lo]!);
      if (e !== undefined) {
        sum -= e;
        count--;
      }
      lo++;
    }
    const p = line[i]!;
    out.push(count > 0 && eleOf(p) !== undefined ? [p[0], p[1], sum / count] : p);
  }
  return out;
}

export interface ProfilePoint {
  /** distance from start, m */
  d: number;
  /** elevation, m (may be undefined if unknown) */
  ele: number | undefined;
  lat: number;
  lon: number;
  /** grade in percent over the preceding sample window */
  gradePct: number;
  /** geometry index */
  idx: number;
}

/**
 * Build an elevation profile sampled at most every `maxSamples` points, with
 * grade computed over `gradeWindowM`. Suitable for charts and hit-testing.
 */
export function buildProfile(line: readonly Position[], opts: { maxSamples?: number; gradeWindowM?: number } = {}): ProfilePoint[] {
  const maxSamples = opts.maxSamples ?? 600;
  const gradeWindow = opts.gradeWindowM ?? 100;
  if (line.length === 0) return [];
  const cum = cumulativeDistances(line);
  const step = Math.max(1, Math.ceil(line.length / maxSamples));
  const pts: ProfilePoint[] = [];
  for (let i = 0; i < line.length; i += step) pts.push(mk(i));
  if (pts[pts.length - 1]!.idx !== line.length - 1) pts.push(mk(line.length - 1));
  // grade
  let j = 0;
  for (let i = 0; i < pts.length; i++) {
    while (j < i && pts[i]!.d - pts[j]!.d > gradeWindow) j++;
    const a = pts[j === i ? Math.max(0, i - 1) : j]!;
    const b = pts[i]!;
    const dd = b.d - a.d;
    pts[i]!.gradePct = dd > 0 && a.ele !== undefined && b.ele !== undefined ? ((b.ele - a.ele) / dd) * 100 : 0;
  }
  return pts;

  function mk(i: number): ProfilePoint {
    const p = line[i]!;
    return { d: cum[i]!, ele: eleOf(p), lat: p[1], lon: p[0], gradePct: 0, idx: i };
  }
}

/** Ascent/descent between two geometry indices (inclusive). */
export function elevationStatsRange(line: readonly Position[], fromIdx: number, toIdx: number, thresholdM = 3): ElevationStats {
  return elevationStats(line.slice(Math.max(0, fromIdx), Math.min(line.length, toIdx + 1)), thresholdM);
}
