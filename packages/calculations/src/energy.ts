/**
 * Energy expenditure estimates. Walking uses the Pandolf equation (1977)
 * with the Santee et al. (2001) downhill correction; cycling uses MET
 * values from the Compendium of Physical Activities. All values are
 * orientational estimates (individual variation is typically ±15–20 %).
 */
import { r, requireNumber } from './internal';

export interface EnergyInput {
  /** Body weight, kg (75 kg assumed when unknown). */
  bodyWeightKg?: number;
  /** Carried load (pack), kg. */
  loadKg: number;
  /** Moving time, minutes. */
  movingMin: number;
  /** Distance, m. */
  distanceM: number;
  /** Ascent, m. */
  ascentM: number;
  /** Descent, m. */
  descentM: number;
  /** Pandolf terrain factor η: 1.0 hard surface, 1.2 dirt road, 1.5 light brush, 1.8 heavy brush, 2.1 swamp, 2.5 loose sand (default 1.0). */
  terrainFactor?: number;
}

export interface EnergyResult {
  /** Energy of the activity itself while moving, kcal. */
  activityKcal: number;
  /** Basal energy for the rest of the 24 h day, kcal. */
  restingKcal: number;
  /** activityKcal + restingKcal, kcal. */
  totalKcal: number;
  method: string;
  /** Czech assumptions. */
  assumptions: string[];
}

const ASSUMED_BODY_KG = 75;
/** Approximate basal metabolic rate, kcal per kg per hour. */
const BMR_KCAL_PER_KG_H = 0.9;
const W_S_PER_KCAL = 4184;

/** Pandolf metabolic rate, W. V in m/s, grade in percent (can be negative). */
function pandolfWatts(w: number, l: number, v: number, g: number, eta: number): number {
  const stat = 1.5 * w + 2 * (w + l) * (l / w) ** 2;
  const dyn = eta * (w + l) * (1.5 * v * v + 0.35 * v * g);
  const m = stat + dyn;
  if (g >= 0) return m;
  // Santee correction for downhill walking, floored at the static part.
  const correction = eta * ((g * (w + l) * v) / 3.5 - ((w + l) * (g + 6) ** 2) / w + 25 - v * v);
  return Math.max(stat, m - correction);
}

/**
 * Estimate walking energy expenditure (Pandolf + Santee).
 * The route is modelled as three parts – climbing at an average 10 % grade,
 * descending at −10 % and the rest flat – sharing the same average speed.
 */
export function estimateEnergyExpenditure(input: EnergyInput): EnergyResult {
  const loadKg = requireNumber('loadKg', input.loadKg, 0, 150);
  const movingMin = requireNumber('movingMin', input.movingMin);
  const distanceM = requireNumber('distanceM', input.distanceM);
  const ascentM = requireNumber('ascentM', input.ascentM);
  const descentM = requireNumber('descentM', input.descentM);
  const eta = requireNumber('terrainFactor', input.terrainFactor ?? 1, 1, 3);
  const w = input.bodyWeightKg !== undefined ? requireNumber('bodyWeightKg', input.bodyWeightKg, 20, 300) : ASSUMED_BODY_KG;
  const assumptions: string[] = [
    'Orientační odhad (Pandolf 1977 + Santee 2001); individuální rozdíly bývají ±15–20 %.',
    'Trasa je rozdělena na stoupání (průměrný sklon 10 %), klesání (−10 %) a rovinu při stejné průměrné rychlosti.',
    `Bazální výdej pro zbytek 24 h dne: ${BMR_KCAL_PER_KG_H} kcal/kg/h.`,
  ];
  if (input.bodyWeightKg === undefined) assumptions.push('Tělesná hmotnost není zadána, předpokládáno 75 kg.');
  if (eta !== 1) assumptions.push(`Faktor terénu η = ${eta}.`);

  const hours = movingMin / 60;
  let activityKcal = 0;
  if (movingMin > 0 && distanceM > 0) {
    const v = distanceM / (movingMin * 60);
    let dUp = ascentM / 0.1;
    let dDown = descentM / 0.1;
    if (dUp + dDown > distanceM) {
      const k = distanceM / (dUp + dDown);
      dUp *= k;
      dDown *= k;
    }
    const dFlat = Math.max(0, distanceM - dUp - dDown);
    const gUp = dUp > 0 ? Math.min(45, (ascentM / dUp) * 100) : 0;
    const gDown = dDown > 0 ? -Math.min(45, (descentM / dDown) * 100) : 0;
    const parts: Array<[number, number]> = [
      [dUp, gUp],
      [dDown, gDown],
      [dFlat, 0],
    ];
    let joules = 0;
    for (const [d, g] of parts) {
      if (d <= 0) continue;
      joules += pandolfWatts(w, loadKg, v, g, eta) * (d / distanceM) * movingMin * 60;
    }
    activityKcal = joules / W_S_PER_KCAL;
  } else if (movingMin > 0) {
    // Standing / no horizontal movement: static terms only.
    activityKcal = ((1.5 * w + 2 * (w + loadKg) * (loadKg / w) ** 2) * movingMin * 60) / W_S_PER_KCAL;
  }
  const restingKcal = BMR_KCAL_PER_KG_H * w * Math.max(0, 24 - hours);
  return {
    activityKcal: r(activityKcal),
    restingKcal: r(restingKcal),
    totalKcal: r(activityKcal) + r(restingKcal),
    method: 'Pandolf (1977) + Santee (2001) downhill correction',
    assumptions,
  };
}

export interface CyclingEnergyInput {
  bodyWeightKg?: number;
  /** Moving time, minutes. */
  movingMin: number;
  /** Distance, m. */
  distanceM: number;
  /** Ascent, m. */
  ascentM?: number;
  /** Bike plus luggage weight, kg (default 15). */
  bikeAndLoadKg?: number;
  /** Mountain-bike style riding (higher MET). */
  offroad?: boolean;
}

/** MET for cycling by average speed (km/h), Compendium of Physical Activities. */
function cyclingMet(speedKmh: number, offroad: boolean): number {
  const road = speedKmh < 16 ? 4 : speedKmh < 19.3 ? 6.8 : speedKmh < 22.5 ? 8 : speedKmh < 25.7 ? 10 : speedKmh < 30.6 ? 12 : 15.8;
  return offroad ? Math.max(road, 8.5) : road;
}

/**
 * Estimate cycling energy expenditure (MET based, cross-checked against the
 * mechanical work of climbing at 23 % gross efficiency; the larger value is used).
 */
export function cyclingEnergy(input: CyclingEnergyInput): EnergyResult {
  const movingMin = requireNumber('movingMin', input.movingMin);
  const distanceM = requireNumber('distanceM', input.distanceM);
  const ascentM = requireNumber('ascentM', input.ascentM ?? 0);
  const bikeKg = requireNumber('bikeAndLoadKg', input.bikeAndLoadKg ?? 15, 0, 150);
  const w = input.bodyWeightKg !== undefined ? requireNumber('bodyWeightKg', input.bodyWeightKg, 20, 300) : ASSUMED_BODY_KG;
  const hours = movingMin / 60;
  const speed = hours > 0 ? distanceM / 1000 / hours : 0;
  const met = hours > 0 ? cyclingMet(speed, input.offroad ?? false) : 0;
  const metKcal = met * w * hours;
  const climbKcal = (ascentM * (w + bikeKg) * 9.81) / (0.23 * W_S_PER_KCAL) + 4 * w * hours;
  const activityKcal = Math.max(metKcal, climbKcal);
  const restingKcal = BMR_KCAL_PER_KG_H * w * Math.max(0, 24 - hours);
  const assumptions = [
    `Metoda MET: průměrná rychlost ${r(speed, 1)} km/h → ${met} MET; odhad, individuální rozdíly bývají ±20 %.`,
    'Při stoupání se použije vyšší z hodnoty podle MET a mechanické práce (účinnost 23 %).',
    `Bazální výdej pro zbytek 24 h dne: ${BMR_KCAL_PER_KG_H} kcal/kg/h.`,
  ];
  if (input.bodyWeightKg === undefined) assumptions.push('Tělesná hmotnost není zadána, předpokládáno 75 kg.');
  return {
    activityKcal: r(activityKcal),
    restingKcal: r(restingKcal),
    totalKcal: r(activityKcal) + r(restingKcal),
    method: 'MET (Compendium of Physical Activities) + mechanická práce stoupání',
    assumptions,
  };
}

export interface IntakeRecommendation {
  minKcal: number;
  maxKcal: number;
  /** Czech note on how orientational the range is. */
  note: string;
}

/**
 * Orientational daily intake range for multi-day trips: about 85–100 % of
 * the estimated expenditure (a small deficit is common and acceptable on
 * short trips). Rounded to 50 kcal.
 */
export function recommendedIntakeKcal(totalKcal: number): IntakeRecommendation {
  requireNumber('totalKcal', totalKcal);
  const round50 = (v: number) => Math.round(v / 50) * 50;
  return {
    minKcal: round50(totalKcal * 0.85),
    maxKcal: round50(totalKcal),
    note: 'Orientační rozmezí (85–100 % odhadovaného výdeje); nejde o lékařské ani dietní doporučení. Při dlouhých výletech nebo chladu počítejte spíše s horní hranicí.',
  };
}
