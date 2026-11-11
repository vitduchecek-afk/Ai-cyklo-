/**
 * Moving-time estimation.
 *
 * Hiking uses the DIN 33466 model (horizontal and vertical components are
 * computed separately, the total is the larger one plus half of the smaller
 * one). Cycling uses a flat speed per discipline and surface plus a climbing
 * rate (VAM, vertical metres per hour) by fitness.
 *
 * All results are ESTIMATES; every result carries an uncertainty percentage.
 */
import type { ActivityType, FitnessLevel, Position } from '@trailpack/shared';
import { isCyclingActivity } from '@trailpack/shared';
import { cumulativeDistances } from './geo';
import { elevationStats, smoothElevations } from './elevation';
import { invalid, r, requireNumber } from './internal';

export type TerrainKind = 'road' | 'trail' | 'rough' | 'scramble' | 'snow';

/** Input of {@link estimateMovingTime}. */
export interface TimeInput {
  /** Horizontal distance, m. */
  distanceM: number;
  /** Total ascent, m. */
  ascentM: number;
  /** Total descent, m. */
  descentM: number;
  activity: ActivityType;
  fitness: FitnessLevel;
  /** Horizontal walking/cycling speed on flat ground, km/h. Overrides the default by fitness/activity. */
  paceKmh?: number;
  /** Carried pack weight (hiking) or luggage weight (cycling), kg. */
  packWeightKg?: number;
  terrain?: TerrainKind;
  /** Body weight, kg. 75 kg is assumed when unknown. */
  bodyWeightKg?: number;
}

/** Time input without the geometry-derived fields (used for stage splitting). */
export type TimeParams = Omit<TimeInput, 'distanceM' | 'ascentM' | 'descentM'>;

export interface MovingTimeResult {
  /** Estimated pure moving time, minutes (without breaks). */
  movingMin: number;
  model: 'DIN33466' | 'cycling_vam';
  /** Multiplicative factors applied (1 = no effect). */
  factors: Record<string, number>;
  /** Czech explanation lines. */
  explanation: string[];
  /** Estimated relative uncertainty, percent (±). */
  uncertaintyPct: number;
}

/** Default hiking horizontal pace by fitness, km/h. */
export const DEFAULT_HIKING_PACE_KMH: Record<FitnessLevel, number> = { low: 3.5, moderate: 4.0, good: 4.5, excellent: 5.0 };
/** DIN 33466 ascent rate, m/h. */
export const DIN_ASCENT_M_PER_H = 300;
/** DIN 33466 descent rate, m/h. */
export const DIN_DESCENT_M_PER_H = 500;
/** Body weight assumed when unknown, kg. */
export const ASSUMED_BODY_WEIGHT_KG = 75;

const FITNESS_VERTICAL_FACTOR: Record<FitnessLevel, number> = { low: 1.2, moderate: 1, good: 0.92, excellent: 0.85 };
const FITNESS_CYCLING_SPEED_FACTOR: Record<FitnessLevel, number> = { low: 0.85, moderate: 1, good: 1.1, excellent: 1.2 };
/** Climbing rate on a bike, m/h. */
const CYCLING_VAM: Record<FitnessLevel, number> = { low: 350, moderate: 500, good: 650, excellent: 800 };
/** Flat speed on a good surface, km/h. */
const CYCLING_FLAT_KMH: Partial<Record<ActivityType, number>> = {
  bikepacking: 16,
  gravel: 20,
  mtb: 13,
  xc: 15,
  road_cycling: 25,
};
const CYCLING_SURFACE_FACTOR: Record<TerrainKind, number> = { road: 1, trail: 0.8, rough: 0.6, scramble: 0.35, snow: 0.5 };
const HIKING_TERRAIN_FACTOR: Record<TerrainKind, number> = { road: 0.95, trail: 1, rough: 1.25, scramble: 1.6, snow: 1.5 };

const TERRAIN_CS: Record<TerrainKind, string> = {
  road: 'zpevněná cesta',
  trail: 'stezka',
  rough: 'náročný terén',
  scramble: 'lezecký / skalnatý terén',
  snow: 'sníh',
};

function loadFactor(packKg: number | undefined, bodyKg: number, perExcess: number): { factor: number; fraction: number } {
  const fraction = packKg !== undefined ? packKg / bodyKg : 0;
  const factor = Math.min(1.5, 1 + perExcess * Math.max(0, fraction - 0.1));
  return { factor, fraction };
}

/**
 * Estimate moving time (minutes, no breaks) for a distance/ascent/descent.
 * See module docs for the models. Throws `invalid_input` for negative or
 * non-finite values.
 */
export function estimateMovingTime(input: TimeInput): MovingTimeResult {
  const distanceM = requireNumber('distanceM', input.distanceM);
  const ascentM = requireNumber('ascentM', input.ascentM);
  const descentM = requireNumber('descentM', input.descentM);
  if (input.paceKmh !== undefined) requireNumber('paceKmh', input.paceKmh, 0.5, 60);
  if (input.packWeightKg !== undefined) requireNumber('packWeightKg', input.packWeightKg, 0, 150);
  if (input.bodyWeightKg !== undefined) requireNumber('bodyWeightKg', input.bodyWeightKg, 20, 300);
  const terrain: TerrainKind = input.terrain ?? 'trail';
  const bodyKg = input.bodyWeightKg ?? ASSUMED_BODY_WEIGHT_KG;
  const explanation: string[] = [];
  const factors: Record<string, number> = {};
  const distKm = distanceM / 1000;
  const bodyUnknown = input.bodyWeightKg === undefined;

  if (isCyclingActivity(input.activity)) {
    const baseSpeed = input.paceKmh ?? CYCLING_FLAT_KMH[input.activity] ?? 18;
    const fitSpeed = input.paceKmh !== undefined ? 1 : FITNESS_CYCLING_SPEED_FACTOR[input.fitness];
    const surface = CYCLING_SURFACE_FACTOR[terrain];
    const { factor: load, fraction } = loadFactor(input.packWeightKg, bodyKg, 0.3);
    const speed = baseSpeed * fitSpeed * surface;
    const flatMin = (distKm / speed) * 60;
    const vam = CYCLING_VAM[input.fitness];
    const climbMin = (ascentM / vam) * 60;
    const movingMin = (flatMin + climbMin) * load;
    factors.fitnessSpeed = fitSpeed;
    factors.surface = surface;
    factors.load = r(load, 3);
    explanation.push(
      `Model: jízda na kole – rovinná rychlost ${r(baseSpeed, 1)} km/h × povrch (${TERRAIN_CS[terrain]}) ${surface} × kondice ${fitSpeed} = ${r(speed, 1)} km/h.`,
      `Rovinná část: ${r(distKm, 1)} km při ${r(speed, 1)} km/h = ${r(flatMin)} min.`,
      `Stoupání: ${r(ascentM)} m při ${vam} m/h (VAM podle kondice) = ${r(climbMin)} min; klesání je zahrnuto v průměrné rychlosti.`,
    );
    if (input.packWeightKg !== undefined) {
      explanation.push(
        `Zavazadla ${r(input.packWeightKg, 1)} kg (${r(fraction * 100)} % tělesné hmotnosti${bodyUnknown ? ', předpokládáno 75 kg' : ''}) → faktor ${r(load, 2)}.`,
      );
    }
    let unc = 20;
    if (terrain === 'rough' || terrain === 'scramble' || terrain === 'snow') unc += 10;
    if (input.packWeightKg !== undefined && bodyUnknown) unc += 3;
    explanation.push(`Jde o odhad s nejistotou přibližně ±${unc} %.`);
    return { movingMin: r(movingMin, 1), model: 'cycling_vam', factors, explanation, uncertaintyPct: unc };
  }

  // Hiking: DIN 33466
  const pace = input.paceKmh ?? DEFAULT_HIKING_PACE_KMH[input.fitness];
  const horizMin = (distKm / pace) * 60;
  const ascMin = (ascentM / DIN_ASCENT_M_PER_H) * 60;
  const descMin = (descentM / DIN_DESCENT_M_PER_H) * 60;
  const fitV = FITNESS_VERTICAL_FACTOR[input.fitness];
  const vertMin = (ascMin + descMin) * fitV;
  const base = Math.max(horizMin, vertMin) + Math.min(horizMin, vertMin) / 2;
  const { factor: load, fraction } = loadFactor(input.packWeightKg, bodyKg, 0.6);
  const terr = HIKING_TERRAIN_FACTOR[terrain];
  const movingMin = base * load * terr;
  factors.fitnessVertical = fitV;
  factors.load = r(load, 3);
  factors.terrain = terr;
  explanation.push(
    `Model DIN 33466: vodorovně ${r(distKm, 1)} km při ${r(pace, 1)} km/h = ${r(horizMin)} min.`,
    `Svisle: stoupání ${r(ascentM)} m při ${DIN_ASCENT_M_PER_H} m/h (${r(ascMin)} min) + klesání ${r(descentM)} m při ${DIN_DESCENT_M_PER_H} m/h (${r(descMin)} min)${fitV !== 1 ? `, upraveno faktorem kondice ${fitV}` : ''} = ${r(vertMin)} min.`,
    `Celkem = větší složka + polovina menší = ${r(base)} min (před úpravami).`,
  );
  if (input.packWeightKg !== undefined) {
    explanation.push(
      `Batoh ${r(input.packWeightKg, 1)} kg (${r(fraction * 100)} % tělesné hmotnosti${bodyUnknown ? ', předpokládáno 75 kg' : ''}) → faktor ${r(load, 2)}.`,
    );
  } else {
    explanation.push('Hmotnost batohu není zadána, zátěž nebyla započtena.');
  }
  if (terr !== 1) explanation.push(`Terén (${TERRAIN_CS[terrain]}) → faktor ${terr}.`);
  let unc = 20;
  if (terrain === 'rough' || terrain === 'snow') unc += 10;
  if (terrain === 'scramble') unc += 15;
  if (input.packWeightKg !== undefined && bodyUnknown) unc += 3;
  if (input.paceKmh === undefined) unc += 3;
  explanation.push(`Jde o odhad s nejistotou přibližně ±${unc} %; skutečný čas závisí na počasí, stavu stezky a únavě.`);
  return { movingMin: r(movingMin, 1), model: 'DIN33466', factors, explanation, uncertaintyPct: unc };
}

/** Result of {@link estimateTotalTime}. All values in minutes. */
export interface TotalTime {
  movingMin: number;
  breakMin: number;
  totalMin: number;
}

/**
 * Add breaks to a moving time.
 * @param movingMin moving time, minutes
 * @param breakMinutesPerHour break minutes per hour of moving (0–60)
 */
export function estimateTotalTime(movingMin: number, breakMinutesPerHour: number): TotalTime {
  requireNumber('movingMin', movingMin);
  requireNumber('breakMinutesPerHour', breakMinutesPerHour, 0, 60);
  const breakMin = (movingMin / 60) * breakMinutesPerHour;
  return { movingMin: r(movingMin, 1), breakMin: r(breakMin, 1), totalMin: r(movingMin + breakMin, 1) };
}

/** Relative cost (minutes) of one segment, used to weight time along a line. */
function segmentWeightMin(distM: number, dz: number, params: TimeParams): number {
  const cycling = isCyclingActivity(params.activity);
  const terrain = params.terrain ?? 'trail';
  if (cycling) {
    const base = (params.paceKmh ?? CYCLING_FLAT_KMH[params.activity] ?? 18) * CYCLING_SURFACE_FACTOR[terrain];
    const flat = (distM / 1000 / base) * 60;
    const climb = dz > 0 ? (dz / CYCLING_VAM[params.fitness]) * 60 : 0;
    return flat + climb;
  }
  const pace = params.paceKmh ?? DEFAULT_HIKING_PACE_KMH[params.fitness];
  const horiz = (distM / 1000 / pace) * 60;
  const vert = dz >= 0 ? (dz / DIN_ASCENT_M_PER_H) * 60 : (-dz / DIN_DESCENT_M_PER_H) * 60;
  return horiz + vert;
}

/**
 * Cumulative moving minutes at every vertex of `line`. Grade-aware (steeper
 * segments take longer) but scaled so the last value equals the
 * {@link estimateMovingTime} result for the whole line.
 * @returns array with one entry per vertex, first entry 0, minutes
 */
export function cumulativeMovingMinutes(line: readonly Position[], params: TimeParams): number[] {
  if (line.length < 2) return line.map(() => 0);
  const cum = cumulativeDistances(line);
  const smooth = smoothElevations(line, 50);
  const stats = elevationStats(line);
  const total = estimateMovingTime({
    ...params,
    distanceM: cum[cum.length - 1]!,
    ascentM: stats.ascentM,
    descentM: stats.descentM,
  }).movingMin;
  const weights: number[] = [0];
  let acc = 0;
  for (let i = 1; i < line.length; i++) {
    const a = smooth[i - 1]!;
    const b = smooth[i]!;
    const ea = a.length > 2 ? (a as [number, number, number])[2] : undefined;
    const eb = b.length > 2 ? (b as [number, number, number])[2] : undefined;
    const dz = ea !== undefined && eb !== undefined ? eb - ea : 0;
    acc += segmentWeightMin(cum[i]! - cum[i - 1]!, dz, params);
    weights.push(acc);
  }
  if (acc <= 0) return weights.map(() => 0);
  const k = total / acc;
  return weights.map((w) => w * k);
}

/**
 * Estimated pass time at every vertex of a line.
 * @param line route geometry
 * @param params time parameters (distance/ascent are derived from the line)
 * @param startEpochMs departure, epoch ms
 * @param breakMinutesPerHour break minutes per hour of moving
 * @returns epoch ms per vertex; the last value equals start + total time incl. breaks
 */
export function passTimes(line: readonly Position[], params: TimeParams, startEpochMs: number, breakMinutesPerHour: number): number[] {
  if (!Number.isFinite(startEpochMs)) invalid('Neplatný čas startu.');
  requireNumber('breakMinutesPerHour', breakMinutesPerHour, 0, 60);
  if (line.length === 0) return [];
  const moving = cumulativeMovingMinutes(line, params);
  const factor = 1 + breakMinutesPerHour / 60;
  return moving.map((m) => startEpochMs + m * factor * 60000);
}
