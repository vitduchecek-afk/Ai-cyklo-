/**
 * Deterministic meal planner. Same input + seed → same plan.
 *
 * Quantities are PACKAGES of a food for the whole group (fractions allowed);
 * `targetKcalPerDay` is per person. Day energy is split breakfast 25 %, snack 25 %,
 * lunch 20 %, dinner 30 %; each regular meal is a staple (≈ 65 %) plus a protein/fat
 * or topping (≈ 35 %); snacks are two different snack foods. Food choice is rotated
 * with a seeded hash and a penalty for foods used in the previous two days.
 */
import { TrailPackError } from '@trailpack/shared';
import type { FoodItem, MealPlan, MealPlanEntry, MealType } from '@trailpack/shared';
import { normalizeAllergen, type DietFlag } from './foods';
import { mealPlanTotals } from './totals';

export type CookingMode = 'gas' | 'liquid' | 'alcohol' | 'none' | 'cold_soak';
export type MealPlanDraft = Omit<MealPlan, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

export interface MealPlanRequest {
  /** Trip days (1–60). */
  days: number;
  /** Number of people (1–50). */
  people: number;
  /** Target energy per PERSON and day, kcal. */
  targetKcalPerDay: number;
  foods: readonly FoodItem[];
  diet?: readonly DietFlag[];
  /** Allergens to avoid (EU keys or Czech names, e.g. 'milk', 'mléko', 'lepek'). */
  excludeAllergens?: readonly string[];
  cooking: CookingMode;
  /** Budget per PERSON and day in the foods' currency (CZK for built-ins). */
  budgetPerDay?: number;
  /** Prefer energy-dense (light) foods. */
  preferLight?: boolean;
  /** Add an emergency no-cook reserve (≈ 40 % of one day) on the last day (default true). */
  includeReserve?: boolean;
  seed?: number | string;
  /** Meals eaten on the first day (default all four regular meals). */
  firstDayMeals?: readonly MealType[];
  /** Meals eaten on the last day (default all four regular meals). */
  lastDayMeals?: readonly MealType[];
  name?: string;
  tripId?: string | null;
}

export interface MealPlanResult {
  plan: MealPlanDraft;
  /** Average kcal per person and day over all days, reserve excluded. */
  achievedKcalPerDay: number;
  /** What the target is after removing the meals skipped on first/last day. */
  expectedKcalPerDay: number;
  /** Czech warnings. */
  warnings: string[];
}

export const REGULAR_MEALS = ['breakfast', 'snack', 'lunch', 'dinner'] as const satisfies readonly MealType[];
type RegularMeal = (typeof REGULAR_MEALS)[number];

/** Share of the daily energy per meal. */
export const MEAL_SHARES: Record<RegularMeal, number> = { breakfast: 0.25, snack: 0.25, lunch: 0.2, dinner: 0.3 };
/** Reserve as a share of one day's energy. */
export const RESERVE_SHARE = 0.4;

type Role = 'staple' | 'fat' | 'protein' | 'snack' | 'topping';

/** Heuristic role from macros, package size and cooking need. */
export function foodRole(f: FoodItem): Role {
  const kcal = Math.max(1, f.energyKcal);
  const fat = (9 * f.fatG) / kcal;
  const prot = (4 * f.proteinG) / kcal;
  const carb = (4 * f.carbsG) / kcal;
  const protPer100 = (f.proteinG / f.weightG) * 100;
  if ((f.weightG >= 250 || f.requiresCooking) && protPer100 >= 6 && carb >= 0.5 && fat < 0.5) return 'staple';
  if (fat >= 0.6) return 'fat';
  if (prot >= 0.25) return 'protein';
  if (f.weightG < 250 && kcal / f.weightG >= 3) return 'snack';
  return 'topping';
}

function fnv(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/** Deterministic pseudo-random number in [0, 1). */
const hash01 = (...parts: Array<string | number>): number => fnv(parts.join('|')) / 4294967296;

const stepOf = (f: FoodItem): number => (f.weightG <= 150 ? 0.5 : 0.1);
const roundTo = (v: number, step: number): number => Math.round(Math.round(v / step) * step * 1000) / 1000;

function dietSet(f: FoodItem): Set<string> {
  const s = new Set<string>(f.diet);
  if (s.has('vegan')) {
    s.add('vegetarian');
    s.add('lactose_free');
  }
  return s;
}

function cookingOk(f: FoodItem, mode: CookingMode): boolean {
  switch (mode) {
    case 'none':
      return !f.requiresCooking;
    case 'cold_soak':
      return !f.requiresCooking || f.coldSoakable;
    case 'alcohol':
      return !f.requiresCooking || f.cookMinutes <= 10;
    default:
      return true;
  }
}

/** Generate a meal plan. Throws `TrailPackError('invalid_input')` on impossible parameters. */
export function generateMealPlan(req: MealPlanRequest): MealPlanResult {
  const { days, people } = req;
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new TrailPackError('invalid_input', 'Počet dní musí být celé číslo 1–60.');
  if (!Number.isInteger(people) || people < 1 || people > 50) throw new TrailPackError('invalid_input', 'Počet osob musí být celé číslo 1–50.');
  if (!(req.targetKcalPerDay >= 500 && req.targetKcalPerDay <= 8000)) throw new TrailPackError('invalid_input', 'Denní energie musí být 500–8000 kcal.');

  const seed = req.seed ?? 1;
  const warnings: string[] = [];
  const excluded = new Set((req.excludeAllergens ?? []).map(normalizeAllergen));
  const diet = req.diet ?? [];

  const eligible = req.foods.filter((f) => {
    if (f.energyKcal <= 0 || f.weightG <= 0) return false;
    if (diet.length > 0) {
      const ds = dietSet(f);
      if (!diet.every((d) => ds.has(d))) return false;
    }
    if (f.allergens.some((a) => excluded.has(normalizeAllergen(a)))) return false;
    return cookingOk(f, req.cooking);
  });
  if (eligible.length === 0) warnings.push('Žádná potravina nevyhovuje zadaným omezením (dieta, alergeny, způsob vaření).');

  const pools: Record<RegularMeal, FoodItem[]> = { breakfast: [], snack: [], lunch: [], dinner: [] };
  for (const f of eligible) for (const m of REGULAR_MEALS) if (f.mealTypes.includes(m)) pools[m].push(f);

  const maxDensity = Math.max(1, ...eligible.map((f) => f.energyKcal / f.weightG));
  const pricePerKcal = (f: FoodItem): number => (f.price ?? 0) / Math.max(1, f.energyKcal);
  const maxPpk = Math.max(1e-9, ...eligible.map(pricePerKcal));

  const lastUsed = new Map<string, number>();
  const usedToday = new Set<string>();

  const pick = (pool: readonly FoodItem[], day: number, key: string, exclude: ReadonlySet<string>): FoodItem | undefined => {
    let best: FoodItem | undefined;
    let bestScore = Infinity;
    for (const f of pool) {
      if (exclude.has(f.id)) continue;
      let score = hash01(seed, day, key, f.id);
      const last = lastUsed.get(`${key.split(':')[0]}|${f.id}`);
      if (last !== undefined && day - last <= 2) score += 1 + (3 - (day - last)) * 0.1;
      if (usedToday.has(f.id)) score += 0.5;
      if (req.preferLight) score -= 0.8 * ((f.energyKcal / f.weightG) / maxDensity);
      if (req.budgetPerDay !== undefined) score += 0.8 * (pricePerKcal(f) / maxPpk);
      if (score < bestScore - 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && best && f.id < best.id)) {
        best = f;
        bestScore = score;
      }
    }
    return best;
  };

  const entries: MealPlanEntry[] = [];
  const byId = new Map(req.foods.map((f) => [f.id, f]));
  let expectedSum = 0;

  const addEntry = (dayIndex: number, meal: MealType, f: FoodItem, kcal: number): void => {
    const step = stepOf(f);
    const q = kcal / f.energyKcal;
    if (q < step / 2) return;
    const quantity = Math.max(step, roundTo(q, step));
    const prev = entries.find((e) => e.dayIndex === dayIndex && e.meal === meal && e.foodItemId === f.id);
    if (prev) prev.quantity = roundTo(prev.quantity + quantity, step);
    else entries.push({ dayIndex, meal, foodItemId: f.id, quantity, assignedTo: null });
    lastUsed.set(`${meal}|${f.id}`, dayIndex);
    usedToday.add(f.id);
  };

  const missingMealWarned = new Set<string>();
  for (let day = 0; day < days; day++) {
    usedToday.clear();
    let meals: readonly MealType[] = REGULAR_MEALS;
    if (day === 0 && req.firstDayMeals) meals = req.firstDayMeals;
    if (day === days - 1 && req.lastDayMeals) meals = days === 1 && req.firstDayMeals ? meals.filter((m) => req.lastDayMeals!.includes(m)) : req.lastDayMeals;
    const included = REGULAR_MEALS.filter((m) => meals.includes(m));
    const incShare = included.reduce((s, m) => s + MEAL_SHARES[m], 0);
    expectedSum += incShare;
    const available = included.filter((m) => {
      if (pools[m].length > 0) return true;
      if (!missingMealWarned.has(m)) {
        missingMealWarned.add(m);
        warnings.push(`Pro chod „${MEAL_CS[m]}“ není žádná vhodná potravina – energie je rozdělena do ostatních chodů.`);
      }
      return false;
    });
    const availShare = available.reduce((s, m) => s + MEAL_SHARES[m], 0);
    if (availShare === 0) continue;
    const dayTarget = req.targetKcalPerDay * people * incShare;

    const dayStart = entries.length;
    for (const meal of available) {
      const mealKcal = dayTarget * (MEAL_SHARES[meal] / availShare);
      const pool = pools[meal];
      const used = new Set<string>();
      if (meal === 'snack') {
        const a = pick(pool, day, 'snack:a', used);
        if (a) {
          used.add(a.id);
          const b = pick(pool, day, 'snack:b', used);
          if (b) {
            addEntry(day, meal, a, mealKcal * 0.5);
            addEntry(day, meal, b, mealKcal * 0.5);
          } else addEntry(day, meal, a, mealKcal);
        }
        continue;
      }
      const staples = pool.filter((f) => foodRole(f) === 'staple');
      const primary = pick(staples.length > 0 ? staples : pool, day, `${meal}:p`, used);
      if (!primary) continue;
      used.add(primary.id);
      const rest = pool.filter((f) => f.id !== primary.id);
      const side = rest.filter((f) => {
        const r = foodRole(f);
        return r === 'fat' || r === 'protein' || (meal === 'breakfast' && r === 'topping');
      });
      const secondary = pick(side.length > 0 ? side : rest, day, `${meal}:s`, used);
      if (secondary) {
        addEntry(day, meal, primary, mealKcal * 0.65);
        addEntry(day, meal, secondary, mealKcal * 0.35);
      } else addEntry(day, meal, primary, mealKcal);
    }

    // calibrate the day to within ±5 % using the finest-grained items
    const dayEntries = (): MealPlanEntry[] => entries.slice(dayStart);
    const kcalOf = (): number => dayEntries().reduce((s, e) => s + (byId.get(e.foodItemId)?.energyKcal ?? 0) * e.quantity, 0);
    for (let iter = 0; iter < 4; iter++) {
      const delta = dayTarget - kcalOf();
      if (Math.abs(delta) <= 0.03 * dayTarget) break;
      const cands = [...dayEntries()].sort((a, b) => (byId.get(b.foodItemId)?.weightG ?? 0) - (byId.get(a.foodItemId)?.weightG ?? 0));
      const e = cands[iter % Math.max(1, cands.length)];
      if (!e) break;
      const f = byId.get(e.foodItemId)!;
      const step = stepOf(f);
      const nq = roundTo(e.quantity + delta / f.energyKcal, step);
      if (nq >= step) e.quantity = nq;
    }
  }

  // reserve
  if (req.includeReserve ?? true) {
    const pool = eligible.filter((f) => f.mealTypes.includes('reserve') && !f.requiresCooking);
    const used = new Set<string>();
    const sorted = [...pool].sort((a, b) => b.energyKcal / b.weightG - a.energyKcal / a.weightG || a.id.localeCompare(b.id));
    const a = pick(sorted.slice(0, Math.max(2, Math.ceil(sorted.length / 2))), days - 1, 'reserve:a', used);
    if (a) {
      used.add(a.id);
      const b = pick(sorted, days - 1, 'reserve:b', used);
      const kcal = req.targetKcalPerDay * people * RESERVE_SHARE;
      if (b) {
        addEntry(days - 1, 'reserve', a, kcal * 0.6);
        addEntry(days - 1, 'reserve', b, kcal * 0.4);
      } else addEntry(days - 1, 'reserve', a, kcal);
    } else warnings.push('Nouzovou rezervu nelze sestavit – chybí vhodná nevařená energeticky bohatá potravina.');
  }

  const plan: MealPlanDraft = {
    tripId: req.tripId ?? null,
    name: req.name ?? `Jídelníček ${days} ${days === 1 ? 'den' : days < 5 ? 'dny' : 'dní'}`,
    days,
    people,
    targetKcalPerDay: req.targetKcalPerDay,
    budgetPerDay: req.budgetPerDay,
    dietRestrictions: [...diet, ...[...excluded].map((a) => `bez:${a}`)],
    entries,
  };

  const regular = { ...plan, entries: entries.filter((e) => e.meal !== 'reserve') };
  const totals = mealPlanTotals(regular, req.foods);
  const achievedKcalPerDay = totals.perPerson.kcalPerDay;
  const expectedKcalPerDay = Math.round((req.targetKcalPerDay * expectedSum) / days);
  if (expectedKcalPerDay > 0 && Math.abs(achievedKcalPerDay - expectedKcalPerDay) / expectedKcalPerDay > 0.1) {
    warnings.push(`Průměrná energie ${achievedKcalPerDay} kcal/den se liší od cíle ${expectedKcalPerDay} kcal/den o více než 10 %. Přidejte do nabídky další potraviny.`);
  }
  if (req.budgetPerDay !== undefined) {
    const full = mealPlanTotals(plan, req.foods);
    const perDay = full.total.cost / people / days;
    if (perDay > req.budgetPerDay) warnings.push(`Odhadovaná cena ${Math.round(perDay)} na osobu a den překračuje rozpočet ${req.budgetPerDay}.`);
    if (entries.some((e) => byId.get(e.foodItemId)?.price === undefined)) warnings.push('Některé potraviny nemají cenu – celková cena je podhodnocená.');
  }
  if (!req.preferLight && totals.perPerson.weightGPerDay > 900) {
    warnings.push(`Jídlo váží ${totals.perPerson.weightGPerDay} g na osobu a den. Pro nižší hmotnost zapněte preferenci lehkých potravin.`);
  }
  for (const m of REGULAR_MEALS) {
    if (pools[m].length > 0 && pools[m].length < 3) warnings.push(`Pro chod „${MEAL_CS[m]}“ jsou jen ${pools[m].length} vhodné potraviny – jídelníček se bude opakovat.`);
  }
  if (req.foods.some((f) => f.source === 'builtin_typical')) {
    warnings.push('Použité hodnoty jsou typické, ne z konkrétních výrobků – energii, alergeny a cenu ověřte na obalech.');
  }
  return { plan, achievedKcalPerDay, expectedKcalPerDay, warnings };
}

const MEAL_CS: Record<MealType, string> = { breakfast: 'snídaně', snack: 'svačiny', lunch: 'oběd', dinner: 'večeře', drink: 'nápoje', reserve: 'rezerva' };
