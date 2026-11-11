/**
 * Water planning. The sweat-rate model is an orientational estimate
 * (about 0.4–1.0 l/h while moving) and NOT medical advice.
 */
import type { Advisory } from '@trailpack/shared';
import { advisory, r, requireInt, requireNumber } from './internal';

export type WaterIntensity = 'low' | 'moderate' | 'high';

export interface RefillPoint {
  /** Position along the route, km. */
  atKm: number;
  name?: string;
  reliability: 'high' | 'medium' | 'low';
  potable: boolean;
}

export interface WaterInput {
  /** Duration of the day, hours (moving + breaks). */
  durationH: number;
  /** Moving hours of the day. */
  movingH: number;
  /** Ascent of the day, m. */
  ascentM: number;
  tempMaxC: number;
  tempMinC?: number;
  humidityPct?: number;
  intensity: WaterIntensity;
  /** Body weight, kg (75 kg assumed when unknown). */
  bodyWeightKg?: number;
  people: number;
  /** Water for cooking per person per day, ml (default 500). */
  cookingMlPerPersonDay?: number;
  /** Number of days for the totals (default 1). */
  days?: number;
  refillPoints?: RefillPoint[];
  /** Distance of the day, km. */
  totalKm: number;
  /** Extra carried water on top of the computed need, percent (default 15). */
  safetyReservePct?: number;
}

export interface RefillPlanEntry {
  atKm: number;
  name?: string;
  /** Total volume to carry after refilling (litres, whole group). */
  fillToL: number;
  /** True when the water should be treated (filter, boiling, tablets). */
  treat: boolean;
}

export interface WaterResult {
  /** Drinking water for the whole group and all days, litres. */
  drinkingL: number;
  /** Cooking water for the whole group and all days, litres. */
  cookingL: number;
  totalL: number;
  /** Total need per person per day (drinking + cooking), litres. */
  perPersonL: number;
  /** Volume to carry at the start of a day, litres (whole group, incl. reserve). */
  carryAtStartL: number;
  /** Largest volume carried at any time of a day, litres (whole group, incl. reserve). */
  maxCarryL: number;
  refillPlan: RefillPlanEntry[];
  /** Weight of the maximum carried water, kg (1 l = 1 kg). */
  waterWeightKg: number;
  advisories: Advisory[];
  /** Czech assumptions and notes. */
  assumptions: string[];
}

const BASE_RATE_L_PER_H: Record<WaterIntensity, number> = { low: 0.35, moderate: 0.55, high: 0.8 };
const INTENSITY_CS: Record<WaterIntensity, string> = { low: 'nízká', moderate: 'střední', high: 'vysoká' };

/**
 * Plan drinking and cooking water for a day (and totals for `days`).
 * Only refill points with reliability other than `low` are used for planning.
 */
export function calculateWaterNeeds(input: WaterInput): WaterResult {
  const durationH = requireNumber('durationH', input.durationH, 0, 48);
  const movingH = requireNumber('movingH', input.movingH, 0, 48);
  const ascentM = requireNumber('ascentM', input.ascentM);
  const tempMax = requireNumber('tempMaxC', input.tempMaxC, -60, 60);
  const tempMin = input.tempMinC !== undefined ? requireNumber('tempMinC', input.tempMinC, -60, 60) : undefined;
  const humidity = input.humidityPct !== undefined ? requireNumber('humidityPct', input.humidityPct, 0, 100) : undefined;
  const people = requireInt('people', input.people, 1, 100);
  const days = requireInt('days', input.days ?? 1, 1, 365);
  const totalKm = requireNumber('totalKm', input.totalKm);
  const reservePct = requireNumber('safetyReservePct', input.safetyReservePct ?? 15, 0, 100);
  const cookingMl = requireNumber('cookingMlPerPersonDay', input.cookingMlPerPersonDay ?? 500, 0, 10000);
  const bodyKg = input.bodyWeightKg !== undefined ? requireNumber('bodyWeightKg', input.bodyWeightKg, 20, 300) : 75;
  const movingHours = Math.min(movingH, durationH > 0 ? Math.max(durationH, movingH) : movingH);

  const assumptions: string[] = [
    'Orientační výpočet podle modelu potivosti (cca 0,4–1,0 l/h za pohybu); nejde o lékařské doporučení. Potřeba vody se u každého liší, pijte podle žízně a barvy moči.',
  ];
  if (input.bodyWeightKg === undefined) assumptions.push('Tělesná hmotnost není zadána, předpokládáno 75 kg.');
  if (humidity === undefined) assumptions.push('Vlhkost vzduchu není zadána, vliv vlhkosti nebyl započten.');

  // Effective temperature: daytime weighted when the night minimum is known.
  const tempEff = tempMin !== undefined ? 0.7 * tempMax + 0.3 * tempMin : tempMax;
  const tempFactor = tempEff >= 15 ? Math.min(2, 1 + 0.04 * (tempEff - 15)) : Math.max(0.7, 1 - 0.015 * (15 - tempEff));
  const humFactor = humidity !== undefined && humidity > 60 ? 1 + Math.min(0.16, 0.004 * (humidity - 60)) : 1;
  const weightFactor = Math.sqrt(bodyKg / 75);
  const rate = Math.min(1, Math.max(0.4, BASE_RATE_L_PER_H[input.intensity] * tempFactor * humFactor * weightFactor));
  const ascentExtra = (ascentM / 1000) * 0.2;
  const restH = Math.max(0, durationH - movingHours);
  const restRate = 0.1 * Math.min(1.5, tempFactor);
  const drinkPerPersonDay = rate * movingHours + ascentExtra + restRate * restH;
  assumptions.push(
    `Intenzita ${INTENSITY_CS[input.intensity]}, efektivní teplota ${r(tempEff, 1)} °C → potivost ${r(rate, 2)} l/h za pohybu, +${r(ascentExtra, 2)} l za stoupání, ${r(restRate * restH, 2)} l při odpočinku.`,
  );

  const cookingPerPersonDay = cookingMl / 1000;
  const drinkingL = drinkPerPersonDay * people * days;
  const cookingL = cookingPerPersonDay * people * days;
  const perPersonL = drinkPerPersonDay + cookingPerPersonDay;

  // Carry planning for one day
  const dailyDrinkGroup = drinkPerPersonDay * people;
  const dailyCookGroup = cookingPerPersonDay * people;
  const perKm = totalKm > 0 ? dailyDrinkGroup / totalKm : 0;
  const reserveMul = 1 + reservePct / 100;
  const allRefills = input.refillPoints ?? [];
  const usable = allRefills
    .filter((p) => p.reliability !== 'low' && p.atKm > 0 && p.atKm < totalKm)
    .sort((a, b) => a.atKm - b.atKm);
  const skipped = allRefills.filter((p) => p.reliability === 'low');
  const advisories: Advisory[] = [];
  if (skipped.length > 0) {
    assumptions.push(`Zdroje s nízkou spolehlivostí (${skipped.length}) nejsou v plánu použity; berte je jen jako rezervu.`);
  }

  const bounds = [0, ...usable.map((p) => p.atKm), totalKm];
  const legCarry: number[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const need = (bounds[i + 1]! - bounds[i]!) * perKm;
    const isLast = i === bounds.length - 2;
    legCarry.push((need + (isLast ? dailyCookGroup : 0)) * reserveMul);
  }
  if (usable.length === 0) {
    advisories.push(
      advisory('water_no_reliable_source', 'warning', 'Na trase není žádný spolehlivý zdroj vody – je třeba nést celou denní potřebu.', {
        params: { carryL: r(legCarry[0] ?? 0, 1) },
        basis: ['zdroje s nízkou spolehlivostí nejsou do plánu zahrnuty'],
        action: 'Ověřte zdroje u místních (chata, obec) nebo naplánujte kratší etapu.',
        uncertainty: 'Zdroje vody v přírodě mohou v suchých obdobích vyschnout.',
      }),
    );
  }
  const refillPlan: RefillPlanEntry[] = usable.map((p, i) => ({
    atKm: p.atKm,
    name: p.name,
    fillToL: r(legCarry[i + 1] ?? 0, 1),
    treat: !p.potable,
  }));
  if (refillPlan.some((p) => p.treat)) {
    advisories.push(
      advisory('water_treatment_recommended', 'info', 'Voda z některých zdrojů není označena jako pitná – doporučujeme ji upravit (filtr, převaření, tablety).', {
        params: { count: refillPlan.filter((p) => p.treat).length },
        action: 'Vezměte si filtr nebo dezinfekční tablety.',
        uncertainty: 'Kvalitu vody u zdroje nelze z dat spolehlivě zaručit.',
      }),
    );
  }

  const carryAtStartL = r(legCarry[0] ?? 0, 1);
  const maxCarryL = r(Math.max(...legCarry, 0), 1);
  const maxPerPerson = maxCarryL / people;
  if (maxPerPerson > 6) {
    advisories.push(
      advisory('water_load_very_heavy', 'danger', `Nést ${r(maxPerPerson, 1)} l vody na osobu je velmi zatěžující (${r(maxCarryL, 1)} kg celkem).`, {
        params: { perPersonL: r(maxPerPerson, 1) },
        action: 'Zkraťte úseky mezi zdroji nebo naplánujte doplnění.',
      }),
    );
  } else if (maxPerPerson > 4) {
    advisories.push(
      advisory('water_load_heavy', 'warning', `Maximální zásoba ${r(maxPerPerson, 1)} l vody na osobu je těžká (cca ${r(maxPerPerson, 1)} kg).`, {
        params: { perPersonL: r(maxPerPerson, 1) },
      }),
    );
  }
  if (tempEff >= 30 || (rate >= 0.9 && tempEff >= 25)) {
    advisories.push(
      advisory('water_heat', 'warning', 'Vysoká teplota a zátěž zvyšují riziko dehydratace a úžehu.', {
        params: { tempEffC: r(tempEff, 1) },
        action: 'Pijte pravidelně, přidejte elektrolyty, přesuňte pohyb na ráno a večer.',
        uncertainty: 'Potřeba tekutin se u jednotlivců významně liší.',
      }),
    );
  }

  return {
    drinkingL: r(drinkingL, 1),
    cookingL: r(cookingL, 1),
    totalL: r(drinkingL + cookingL, 1),
    perPersonL: r(perPersonL, 1),
    carryAtStartL,
    maxCarryL,
    refillPlan,
    waterWeightKg: maxCarryL,
    advisories,
    assumptions,
  };
}
