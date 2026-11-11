/**
 * Multi-day stage planning: split a route into daily stages balanced by
 * moving time and snap the stage ends to nearby, legally acceptable anchors
 * (campsites, shelters, water, towns).
 */
import type { LegalStatus, Position } from '@trailpack/shared';
import { cumulativeDistances, nearestPointOnLine } from './geo';
import { elevationStats, elevationStatsRange } from './elevation';
import { cumulativeMovingMinutes, estimateMovingTime } from './time';
import type { TimeParams } from './time';
import { invalid, r, requireInt, requireNumber } from './internal';

export type AnchorKind = 'campsite' | 'shelter' | 'water' | 'town' | 'other';

/** A place where a stage may end. */
export interface StageAnchor {
  id: string;
  lat: number;
  lon: number;
  kind: AnchorKind;
  /** Legal status of staying overnight; `prohibited` anchors are never used. */
  legalStatus?: LegalStatus;
  /** Higher = preferred (tie-breaker), default 0. */
  priority?: number;
}

export interface SplitOptions {
  /** Number of stages (>= 1). */
  days: number;
  /** Daily distance limit, m (only used for warnings). */
  maxDailyDistanceM?: number;
  /** Daily ascent limit, m (only used for warnings). */
  maxDailyAscentM?: number;
  timeParams: TimeParams;
  anchors?: StageAnchor[];
  /** Max distance between an anchor and the route to be usable, m (default 1500). */
  snapRadiusM?: number;
}

export interface Stage {
  index: number;
  /** Index of the first route vertex of the stage. */
  fromIdx: number;
  /** Index of the last route vertex of the stage. */
  toIdx: number;
  distanceM: number;
  ascentM: number;
  descentM: number;
  /** Estimated moving time of the stage, minutes (DIN/VAM computed per stage). */
  movingMin: number;
  endAnchorId?: string;
  /** Distance from the end anchor to the route, m. */
  endAnchorDistanceM?: number;
  /** Czech descriptions of exceeded limits (empty when all fine). */
  exceedsLimits: string[];
}

const LEGAL_RANK: Record<LegalStatus, number> = { verified_allowed: 3, conditional: 2, unverified: 1, prohibited: 0 };

interface Candidate {
  anchor: StageAnchor;
  vertexIdx: number;
  distToRouteM: number;
  minutes: number;
}

/**
 * Split a route into `days` stages balanced by moving time.
 * Each split is moved to the best legal anchor close (in time) to the ideal
 * position: verified_allowed > conditional > unverified; `prohibited` anchors
 * are ignored. The last stage always ends at the route end.
 * Throws `invalid_input` for lines with < 2 vertices or impossible day counts.
 */
export function splitIntoStages(line: readonly Position[], opts: SplitOptions): Stage[] {
  const days = requireInt('days', opts.days, 1, 365);
  if (line.length < 2) invalid('Trasa musí mít alespoň dva body.');
  if (days > line.length - 1) invalid('Počet dní je větší než počet úseků trasy.');
  const snapRadius = requireNumber('snapRadiusM', opts.snapRadiusM ?? 1500, 0, 100000);
  const cum = cumulativeDistances(line);
  const mins = cumulativeMovingMinutes(line, opts.timeParams);
  const totalMin = mins[mins.length - 1]!;
  const last = line.length - 1;

  const minutesAt = (seg: number, t: number): number => mins[seg]! + (mins[seg + 1]! - mins[seg]!) * t;

  // Prepare anchor candidates (only non-prohibited ones near the route).
  const candidates: Candidate[] = [];
  for (const a of opts.anchors ?? []) {
    if (a.legalStatus === 'prohibited') continue;
    const near = nearestPointOnLine(line, { lat: a.lat, lon: a.lon }, cum);
    if (near.distanceM > snapRadius) continue;
    const seg = Math.min(near.segmentIndex, last - 1);
    const vertexIdx = near.t >= 0.5 ? seg + 1 : seg;
    candidates.push({ anchor: a, vertexIdx, distToRouteM: near.distanceM, minutes: minutesAt(seg, near.t) });
  }

  const stageIdeal = totalMin / days;
  const splits: number[] = [];
  const endAnchors = new Map<number, Candidate>();
  const usedAnchors = new Set<string>();
  let prevIdx = 0;
  for (let k = 1; k < days; k++) {
    const ideal = (totalMin * k) / days;
    // Remaining splits need distinct vertices after this one.
    const maxIdx = last - (days - k);
    const minIdx = prevIdx + 1;
    let best: { c: Candidate; score: number } | undefined;
    for (const c of candidates) {
      if (usedAnchors.has(c.anchor.id) || c.vertexIdx < minIdx || c.vertexIdx > maxIdx) continue;
      const dev = Math.abs(c.minutes - ideal) / Math.max(1, stageIdeal);
      if (dev > 0.3) continue;
      const rank = LEGAL_RANK[c.anchor.legalStatus ?? 'unverified'];
      const score = rank * 0.1 + (c.anchor.priority ?? 0) * 0.01 - dev - c.distToRouteM / 100000;
      if (!best || score > best.score) best = { c, score };
    }
    let idx: number;
    if (best) {
      idx = best.c.vertexIdx;
      usedAnchors.add(best.c.anchor.id);
      endAnchors.set(idx, best.c);
    } else {
      idx = nearestVertexByMinutes(mins, ideal, minIdx, maxIdx);
    }
    splits.push(idx);
    prevIdx = idx;
  }

  const bounds = [0, ...splits, last];
  const stages: Stage[] = [];
  for (let i = 0; i < days; i++) {
    const fromIdx = bounds[i]!;
    const toIdx = bounds[i + 1]!;
    const es = elevationStatsRange(line, fromIdx, toIdx);
    const distanceM = cum[toIdx]! - cum[fromIdx]!;
    const movingMin = estimateMovingTime({ ...opts.timeParams, distanceM, ascentM: es.ascentM, descentM: es.descentM }).movingMin;
    const exceeds: string[] = [];
    if (opts.maxDailyDistanceM !== undefined && distanceM > opts.maxDailyDistanceM) {
      exceeds.push(`Denní vzdálenost ${r(distanceM / 1000, 1)} km překračuje limit ${r(opts.maxDailyDistanceM / 1000, 1)} km.`);
    }
    if (opts.maxDailyAscentM !== undefined && es.ascentM > opts.maxDailyAscentM) {
      exceeds.push(`Denní stoupání ${r(es.ascentM)} m překračuje limit ${r(opts.maxDailyAscentM)} m.`);
    }
    const stage: Stage = {
      index: i,
      fromIdx,
      toIdx,
      distanceM: r(distanceM, 1),
      ascentM: r(es.ascentM),
      descentM: r(es.descentM),
      movingMin,
      exceedsLimits: exceeds,
    };
    const anchor = i < days - 1 ? endAnchors.get(toIdx) : undefined;
    if (anchor) {
      stage.endAnchorId = anchor.anchor.id;
      stage.endAnchorDistanceM = r(anchor.distToRouteM);
    }
    stages.push(stage);
  }
  return stages;
}

function nearestVertexByMinutes(mins: readonly number[], target: number, minIdx: number, maxIdx: number): number {
  let best = minIdx;
  let bestD = Infinity;
  for (let i = minIdx; i <= maxIdx; i++) {
    const d = Math.abs(mins[i]! - target);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Suggest how many days a route needs so that no day exceeds the limits.
 * @param totalDistanceM total distance, m
 * @param ascentM total ascent, m
 * @param maxDailyDistanceM daily distance limit, m
 * @param maxDailyAscentM daily ascent limit, m
 * @param timeParams time model parameters
 * @param maxDailyMovingMin daily moving-time limit, minutes (default 420 = 7 h)
 * @returns number of days (>= 1)
 */
export function suggestDayCount(
  totalDistanceM: number,
  ascentM: number,
  maxDailyDistanceM: number,
  maxDailyAscentM: number,
  timeParams: TimeParams,
  maxDailyMovingMin = 420,
): number {
  requireNumber('totalDistanceM', totalDistanceM);
  requireNumber('ascentM', ascentM);
  requireNumber('maxDailyDistanceM', maxDailyDistanceM, 1);
  requireNumber('maxDailyAscentM', maxDailyAscentM, 1);
  requireNumber('maxDailyMovingMin', maxDailyMovingMin, 1);
  let n = Math.max(1, Math.ceil(totalDistanceM / maxDailyDistanceM), Math.ceil(ascentM / maxDailyAscentM));
  // Descent is unknown here; assume it roughly equals ascent for a balanced estimate.
  while (n < 365) {
    const perDay = estimateMovingTime({ ...timeParams, distanceM: totalDistanceM / n, ascentM: ascentM / n, descentM: ascentM / n }).movingMin;
    if (perDay <= maxDailyMovingMin) break;
    n++;
  }
  return n;
}

/** Convenience: whole-route elevation totals used by callers that only have a line. */
export function routeTotals(line: readonly Position[]): { distanceM: number; ascentM: number; descentM: number } {
  const cum = cumulativeDistances(line);
  const es = elevationStats(line);
  return { distanceM: cum[cum.length - 1] ?? 0, ascentM: es.ascentM, descentM: es.descentM };
}
