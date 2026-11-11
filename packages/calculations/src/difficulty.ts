/**
 * Heuristic difficulty rating and steep-section detection.
 * The rating is an orientational, rule-based score – not an official grade.
 */
import type { ActivityType } from '@trailpack/shared';
import { isCyclingActivity } from '@trailpack/shared';
import type { ProfilePoint } from './elevation';
import type { TerrainKind } from './time';
import { r, requireNumber } from './internal';

export type DifficultyLevel = 'easy' | 'moderate' | 'hard' | 'very_hard' | 'extreme';

export interface DifficultyInput {
  /** Distance, m. */
  distanceM: number;
  /** Total ascent, m. */
  ascentM: number;
  /** Steepest sustained grade, percent (absolute). */
  maxGradePct?: number;
  terrain?: TerrainKind;
  /** Estimated moving time, minutes. */
  movingMin: number;
  activity: ActivityType;
}

export interface DifficultyResult {
  level: DifficultyLevel;
  /** 0 (trivial) – 100 (extreme). */
  score: number;
  /** Czech reasons that drove the score. */
  reasons: string[];
}

const TERRAIN_POINTS: Record<TerrainKind, number> = { road: 0, trail: 2, rough: 8, scramble: 15, snow: 12 };
const TERRAIN_CS: Record<TerrainKind, string> = {
  road: 'zpevněný povrch',
  trail: 'běžná stezka',
  rough: 'náročný terén',
  scramble: 'lezecký / skalnatý terén',
  snow: 'sníh',
};
export const DIFFICULTY_LABELS_CS: Record<DifficultyLevel, string> = {
  easy: 'Snadná',
  moderate: 'Střední',
  hard: 'Náročná',
  very_hard: 'Velmi náročná',
  extreme: 'Extrémní',
};

/**
 * Rate the difficulty of a route/stage.
 * Score = duration (0–45) + ascent (0–25) + steepest grade (0–15) + terrain (0–15),
 * mapped to levels at 20 / 40 / 60 / 80.
 */
export function rateDifficulty(input: DifficultyInput): DifficultyResult {
  const distanceM = requireNumber('distanceM', input.distanceM);
  const ascentM = requireNumber('ascentM', input.ascentM);
  const movingMin = requireNumber('movingMin', input.movingMin);
  const maxGrade = input.maxGradePct !== undefined ? Math.abs(requireNumber('maxGradePct', Math.abs(input.maxGradePct), 0, 200)) : undefined;
  const cycling = isCyclingActivity(input.activity);
  const terrain = input.terrain ?? 'trail';
  const reasons: string[] = [];

  const hours = movingMin / 60;
  // Cycling day lengths are naturally longer than hiking ones.
  const hoursFull = cycling ? 12 : 10;
  const durationPts = Math.min(45, (hours / hoursFull) * 45);
  const ascentFull = cycling ? 4000 : 3000;
  const ascentPts = Math.min(25, (ascentM / ascentFull) * 25);
  const gradeFull = cycling ? 20 : 40;
  const gradePts = maxGrade === undefined ? 0 : Math.min(15, (maxGrade / gradeFull) * 15);
  const terrainPts = TERRAIN_POINTS[terrain];

  const score = Math.round(Math.min(100, durationPts + ascentPts + gradePts + terrainPts));
  const level: DifficultyLevel = score < 20 ? 'easy' : score < 40 ? 'moderate' : score < 60 ? 'hard' : score < 80 ? 'very_hard' : 'extreme';

  reasons.push(`Délka pohybu ${r(hours, 1)} h (${r(distanceM / 1000, 1)} km) – ${r(durationPts)} b.`);
  if (ascentM > 0) reasons.push(`Stoupání ${r(ascentM)} m – ${r(ascentPts)} b.`);
  if (maxGrade !== undefined) {
    reasons.push(`Nejstrmější úsek ${r(maxGrade)} % – ${r(gradePts)} b.`);
    if (maxGrade >= (cycling ? 15 : 30)) reasons.push('Obsahuje velmi strmé úseky, které zpomalují a zvyšují riziko uklouznutí.');
  }
  if (terrainPts > 2) reasons.push(`Terén: ${TERRAIN_CS[terrain]} – ${terrainPts} b.`);
  reasons.push(`Celkové skóre ${score}/100 – ${DIFFICULTY_LABELS_CS[level].toLowerCase()} (orientační hodnocení, nikoli oficiální klasifikace).`);
  return { level, score, reasons };
}

export interface SteepSection {
  /** Distance from route start where the section begins, m. */
  fromD: number;
  /** Distance from route start where the section ends, m. */
  toD: number;
  /** Signed grade with the largest absolute value in the section, percent (negative = descent). */
  maxGradePct: number;
  /** Geometry index of the first vertex. */
  idxFrom: number;
  /** Geometry index of the last vertex. */
  idxTo: number;
}

/**
 * Find contiguous sections whose absolute grade is at least `thresholdPct`.
 * Ascending and descending runs are reported separately.
 * @param profile profile from `buildProfile`
 * @param thresholdPct minimum absolute grade, percent (> 0)
 */
export function findSteepSections(profile: readonly ProfilePoint[], thresholdPct: number): SteepSection[] {
  requireNumber('thresholdPct', thresholdPct, 0.1, 200);
  const out: SteepSection[] = [];
  let cur: SteepSection | null = null;
  let sign = 0;
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i]!;
    const steep = Math.abs(p.gradePct) >= thresholdPct;
    const s = Math.sign(p.gradePct);
    if (steep && cur && s === sign) {
      cur.toD = p.d;
      cur.idxTo = p.idx;
      if (Math.abs(p.gradePct) > Math.abs(cur.maxGradePct)) cur.maxGradePct = p.gradePct;
      continue;
    }
    if (cur) {
      out.push(cur);
      cur = null;
    }
    if (steep) {
      const prev = profile[i - 1];
      cur = { fromD: prev ? prev.d : p.d, toD: p.d, maxGradePct: p.gradePct, idxFrom: prev ? prev.idx : p.idx, idxTo: p.idx };
      sign = s;
    }
  }
  if (cur) out.push(cur);
  for (const s of out) s.maxGradePct = r(s.maxGradePct, 1);
  return out;
}
