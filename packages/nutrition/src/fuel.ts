/**
 * Stove fuel estimate. A rule-of-thumb model – real consumption depends on the
 * stove, pot, wind and operator, so the result always carries an uncertainty.
 *
 * Baselines at 20 °C water, calm air, lid on, no windscreen:
 * - gas (isobutane/propane): ~11 g per litre boiled (typical 10–12 g/l); with heat exchanger ~8 g/l,
 * - liquid fuel (petrol/white gas): ~22 ml per litre,
 * - alcohol: ~27.5 ml per litre (typical 25–30 ml/l).
 */

export type StoveFuelType = 'gas' | 'liquid' | 'alcohol';

export interface FuelBoil {
  /** Water to heat, ml. */
  waterMl: number;
  /** Additional simmering time, minutes. */
  simmerMin?: number;
}

export interface FuelInput {
  stove: StoveFuelType;
  /** Explicit boils; when given, the derived meal/drink plan below is ignored. */
  boils?: readonly FuelBoil[];
  /** Hot meals per day and person (default 2). */
  mealsPerDay?: number;
  /** Water per hot meal and person, ml (default 500). */
  waterMlPerMeal?: number;
  days?: number;
  people?: number;
  /** Hot drinks per day and person, 250 ml each (default 1). */
  hotDrinksPerDay?: number;
  /** Ambient temperature, °C (default 20). Also approximates the water start temperature. */
  ambientTempC?: number;
  windy?: boolean;
  windscreen?: boolean;
  altitudeM?: number;
  /** Gas stoves only: pot with heat exchanger (about 30 % less gas). */
  heatExchanger?: boolean;
}

export interface CanisterRecommendation {
  /** Net gas content, g. */
  sizeG: 100 | 230 | 450;
  count: number;
}

export interface FuelEstimate {
  stove: StoveFuelType;
  unit: 'g' | 'ml';
  /** Gas: grams of gas. */
  fuelG?: number;
  /** Liquid / alcohol: millilitres. */
  fuelMl?: number;
  /** Fuel without reserve, in `unit`. */
  amount: number;
  /** Fuel including reserve (≥ +20 %), in `unit`. */
  withReserve: number;
  reserveFactor: number;
  /** Gas only: cheapest canister combination whose usable content covers `withReserve`. */
  recommendedCanisters?: CanisterRecommendation[];
  /** Gas only: usable gas of the recommended canisters, g. */
  canisterCapacityG?: number;
  totalWaterMl: number;
  totalSimmerMin: number;
  /** Relative uncertainty of `amount`, percent. */
  uncertaintyPct: number;
  /** Czech assumptions and caveats. */
  assumptions: string[];
}

/** Baseline fuel per litre of water heated from 20 °C to boiling, calm air. */
export const BASE_FUEL_PER_LITRE = { gas: 11, liquid: 22, alcohol: 27.5 } as const;
/** Fuel use while simmering, per minute (gas g, liquid/alcohol ml). */
export const SIMMER_PER_MIN = { gas: 0.8, liquid: 0.5, alcohol: 0.8 } as const;
/** Per-boil start-up loss (gas g; liquid ml priming; alcohol none). */
export const STARTUP_PER_BOIL = { gas: 0.5, liquid: 4, alcohol: 0 } as const;
const WIND_NO_SCREEN = { gas: 1.75, liquid: 1.5, alcohol: 2 } as const;
const WIND_SCREEN = { gas: 1.15, liquid: 1.1, alcohol: 1.25 } as const;
const CANISTER_SIZES: ReadonlyArray<100 | 230 | 450> = [100, 230, 450];

/** Gas-stove efficiency loss factor from cold (isobutane evaporates poorly below 0 °C). */
export function coldGasFactor(tempC: number): number {
  const pts: Array<[number, number]> = [
    [15, 1],
    [0, 1.25],
    [-10, 1.6],
    [-20, 2],
  ];
  if (tempC >= pts[0]![0]) return 1;
  if (tempC <= pts[pts.length - 1]![0]) return pts[pts.length - 1]![1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [t0, f0] = pts[i]!;
    const [t1, f1] = pts[i + 1]!;
    if (tempC <= t0 && tempC >= t1) return f0 + ((f1 - f0) * (t0 - tempC)) / (t0 - t1);
  }
  return 1;
}

/** Approximate boiling point of water at altitude, °C (≈ −1 °C per 300 m). */
export const boilingPointC = (altitudeM: number): number => 100 - Math.max(0, altitudeM) / 300;

/** Pick the cheapest canister set (fewest total grams, then fewest canisters) covering `needG` usable grams. */
export function chooseCanisters(needG: number, usableFraction: number): { items: CanisterRecommendation[]; capacityG: number } {
  let best: { counts: [number, number, number]; capacity: number; n: number } | undefined;
  for (let a = 0; a <= 6; a++)
    for (let b = 0; b <= 6; b++)
      for (let c = 0; c <= 6; c++) {
        const gross = a * 100 + b * 230 + c * 450;
        const usable = gross * usableFraction;
        if (usable < needG || a + b + c === 0) continue;
        const n = a + b + c;
        if (!best || gross < best.capacity || (gross === best.capacity && n < best.n)) best = { counts: [a, b, c], capacity: gross, n };
      }
  if (!best) {
    const c = Math.ceil(needG / (450 * usableFraction));
    return { items: [{ sizeG: 450, count: c }], capacityG: Math.round(c * 450 * usableFraction) };
  }
  const items = CANISTER_SIZES.map((sizeG, i) => ({ sizeG, count: best!.counts[i]! })).filter((x) => x.count > 0);
  return { items, capacityG: Math.round(best.capacity * usableFraction) };
}

/** Estimate fuel for a trip. Pure. */
export function estimateFuel(input: FuelInput): FuelEstimate {
  const { stove } = input;
  const days = Math.max(1, input.days ?? 1);
  const people = Math.max(1, input.people ?? 1);
  const temp = input.ambientTempC ?? 20;
  const altitude = input.altitudeM ?? 0;

  let boils: FuelBoil[];
  if (input.boils && input.boils.length > 0) boils = input.boils.map((b) => ({ ...b }));
  else {
    const meals = input.mealsPerDay ?? 2;
    const perMeal = input.waterMlPerMeal ?? 500;
    const drinks = input.hotDrinksPerDay ?? 1;
    boils = [{ waterMl: days * people * (meals * perMeal + drinks * 250) }];
  }
  const totalWaterMl = boils.reduce((s, b) => s + Math.max(0, b.waterMl), 0);
  const totalSimmerMin = boils.reduce((s, b) => s + Math.max(0, b.simmerMin ?? 0), 0);

  // heating energy relative to the 20 °C → 100 °C baseline (80 K)
  const waterStart = Math.min(20, Math.max(2, temp));
  const dT = Math.max(10, boilingPointC(altitude) - waterStart);
  let perLitre = (BASE_FUEL_PER_LITRE[stove] * dT) / 80;
  if (stove === 'gas') {
    if (input.heatExchanger) perLitre *= 8 / 11;
    perLitre *= coldGasFactor(temp);
  }
  if (stove === 'alcohol' && temp < 5) perLitre *= 1.2;
  if (altitude > 1000) perLitre *= 1 + 0.02 * (altitude / 1000);
  const windFactor = input.windy ? (input.windscreen ? WIND_SCREEN[stove] : WIND_NO_SCREEN[stove]) : 1;
  perLitre *= windFactor;

  const simmerRate = SIMMER_PER_MIN[stove] * (stove === 'gas' ? coldGasFactor(temp) : 1) * windFactor;
  const amount = (totalWaterMl / 1000) * perLitre + totalSimmerMin * simmerRate + boils.length * STARTUP_PER_BOIL[stove];

  let uncertainty = stove === 'alcohol' ? 35 : 25;
  if (input.windy) uncertainty += input.windscreen ? 5 : 15;
  if (temp < 0) uncertainty += 10;
  if (altitude > 2000) uncertainty += 10;
  uncertainty = Math.min(60, uncertainty);
  const reserveFactor = Math.max(1.2, 1 + (uncertainty / 100) * 0.6);

  const unit = stove === 'gas' ? 'g' : 'ml';
  const round = (n: number): number => Math.round(n * 10) / 10;
  const withReserve = Math.ceil(amount * reserveFactor);

  const assumptions: string[] = [
    stove === 'gas'
      ? `Základ: ~10–12 g izobutanu na litr převařené vody při 20 °C bez větru (použito ${BASE_FUEL_PER_LITRE.gas} g/l${input.heatExchanger ? ', s výměníkem tepla ≈ 8 g/l' : ''}).`
      : stove === 'alcohol'
        ? `Základ: ~25–30 ml lihu na litr převařené vody (použito ${BASE_FUEL_PER_LITRE.alcohol} ml/l); lihové vařiče jsou málo výkonné a na větru ztrácejí hodně.`
        : `Základ: ~${BASE_FUEL_PER_LITRE.liquid} ml benzínu/petroleje na litr převařené vody při 20 °C bez větru, plus ${STARTUP_PER_BOIL.liquid} ml na zahřátí hořáku při každém startu.`,
    `Voda celkem ${Math.round(totalWaterMl)} ml, vaření na mírném plameni ${Math.round(totalSimmerMin)} min.`,
    `Rezerva ${Math.round((reserveFactor - 1) * 100)} % (minimum 20 %) kvůli nejistotě odhadu ±${uncertainty} %.`,
  ];
  if (temp < 20) assumptions.push(`Studená voda (${temp} °C) potřebuje více energie k ohřevu.`);
  if (stove === 'gas' && temp < 0) assumptions.push(`Pod 0 °C klesá výkon kartuše (izobutan se špatně odpařuje); použit koeficient ×${coldGasFactor(temp).toFixed(2)}. Kartuši držte v teple (v bundě, spacáku) a používejte zimní směs s propanem.`);
  if (input.windy && !input.windscreen) assumptions.push(`Vítr bez zástěny zvyšuje spotřebu o ${Math.round((windFactor - 1) * 100)} % (běžně +50 až +100 %). Použijte závětří nebo zástěnu.`);
  if (input.windy && input.windscreen) assumptions.push(`Vítr se zástěnou: spotřeba +${Math.round((windFactor - 1) * 100)} %. Zástěna nesmí těsně obklopit kartuši (nebezpečí přehřátí).`);
  if (altitude > 1000) assumptions.push(`Nadmořská výška ${Math.round(altitude)} m: voda vře při ~${boilingPointC(altitude).toFixed(0)} °C, vaření trvá déle a hořák je méně účinný.`);

  const out: FuelEstimate = {
    stove,
    unit,
    amount: round(amount),
    withReserve,
    reserveFactor: Math.round(reserveFactor * 100) / 100,
    totalWaterMl,
    totalSimmerMin,
    uncertaintyPct: uncertainty,
    assumptions,
  };
  if (stove === 'gas') {
    out.fuelG = round(amount);
    const usable = temp < 0 ? 0.8 : 0.9;
    const c = chooseCanisters(withReserve, usable);
    out.recommendedCanisters = c.items;
    out.canisterCapacityG = c.capacityG;
    assumptions.push(`Kartuše: využitelných ~${Math.round(usable * 100)} % obsahu (zbytek se v chladu nevyplyne).`);
  } else out.fuelMl = round(amount);
  return out;
}
