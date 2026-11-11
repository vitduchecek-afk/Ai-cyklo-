/**
 * Meal plan totals. `entry.quantity` is a number of PACKAGES of the food
 * (fractions allowed) for the WHOLE group; food values are per package.
 */
import type { FoodItem, MealPlan, MealPlanEntry } from '@trailpack/shared';

export interface DayTotals {
  dayIndex: number;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** Food weight, grams (dry/packaged). */
  weightG: number;
  /** Cost in the foods' currency (CZK for built-ins); foods without price count as 0. */
  cost: number;
  /** Water needed for preparation, ml. */
  waterMl: number;
  /** Stove time per day, minutes: per meal the longest cook time among its foods. */
  cookMinutes: number;
}

export interface PlanTotals {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  weightG: number;
  cost: number;
  waterMl: number;
  cookMinutes: number;
}

export interface PerPersonTotals extends PlanTotals {
  /** Average kcal per person and day (over `plan.days`). */
  kcalPerDay: number;
  weightGPerDay: number;
}

export interface MealPlanTotals {
  perDay: DayTotals[];
  total: PlanTotals;
  perPerson: PerPersonTotals;
  /** kcal per gram of food weight. */
  energyDensityKcalPerG: number;
  /** Entries referencing foods not in `foods` (ignored in sums). */
  missingFoodIds: string[];
  /** Share of macro calories (4/4/9 kcal per g), percent. */
  macroPct: { protein: number; carbs: number; fat: number };
}

type PlanLike = Pick<MealPlan, 'days' | 'people'> & { entries: readonly MealPlanEntry[] };

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** Aggregate a meal plan. Pure; unknown foods are listed in `missingFoodIds`. */
export function mealPlanTotals(plan: PlanLike, foods: readonly FoodItem[]): MealPlanTotals {
  const byId = new Map(foods.map((f) => [f.id, f]));
  const maxDay = Math.max(plan.days - 1, ...plan.entries.map((e) => e.dayIndex), 0);
  const days: DayTotals[] = Array.from({ length: maxDay + 1 }, (_, dayIndex) => ({
    dayIndex,
    kcal: 0,
    proteinG: 0,
    carbsG: 0,
    fatG: 0,
    weightG: 0,
    cost: 0,
    waterMl: 0,
    cookMinutes: 0,
  }));
  const missing = new Set<string>();
  const mealCook = new Map<string, number>();

  for (const e of plan.entries) {
    const f = byId.get(e.foodItemId);
    if (!f) {
      missing.add(e.foodItemId);
      continue;
    }
    const d = days[e.dayIndex]!;
    const q = e.quantity;
    d.kcal += f.energyKcal * q;
    d.proteinG += f.proteinG * q;
    d.carbsG += f.carbsG * q;
    d.fatG += f.fatG * q;
    d.weightG += f.weightG * q;
    d.cost += (f.price ?? 0) * q;
    d.waterMl += f.waterMl * q;
    if (f.requiresCooking) {
      const key = `${e.dayIndex}:${e.meal}`;
      mealCook.set(key, Math.max(mealCook.get(key) ?? 0, f.cookMinutes));
    }
  }
  for (const [key, mins] of mealCook) days[Number(key.split(':')[0])]!.cookMinutes += mins;

  const total: PlanTotals = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, weightG: 0, cost: 0, waterMl: 0, cookMinutes: 0 };
  for (const d of days) {
    total.kcal += d.kcal;
    total.proteinG += d.proteinG;
    total.carbsG += d.carbsG;
    total.fatG += d.fatG;
    total.weightG += d.weightG;
    total.cost += d.cost;
    total.waterMl += d.waterMl;
    total.cookMinutes += d.cookMinutes;
  }
  const round = (t: PlanTotals): PlanTotals => ({
    kcal: Math.round(t.kcal),
    proteinG: r1(t.proteinG),
    carbsG: r1(t.carbsG),
    fatG: r1(t.fatG),
    weightG: Math.round(t.weightG),
    cost: Math.round(t.cost * 100) / 100,
    waterMl: Math.round(t.waterMl),
    cookMinutes: Math.round(t.cookMinutes),
  });
  const people = Math.max(1, plan.people);
  const nDays = Math.max(1, plan.days);
  const perPerson: PerPersonTotals = {
    kcal: Math.round(total.kcal / people),
    proteinG: r1(total.proteinG / people),
    carbsG: r1(total.carbsG / people),
    fatG: r1(total.fatG / people),
    weightG: Math.round(total.weightG / people),
    cost: Math.round((total.cost / people) * 100) / 100,
    waterMl: Math.round(total.waterMl / people),
    cookMinutes: Math.round(total.cookMinutes),
    kcalPerDay: Math.round(total.kcal / people / nDays),
    weightGPerDay: Math.round(total.weightG / people / nDays),
  };
  const macroKcal = 4 * total.proteinG + 4 * total.carbsG + 9 * total.fatG;
  const pct = (kcal: number): number => (macroKcal > 0 ? r1((kcal / macroKcal) * 100) : 0);

  return {
    perDay: days.map((d) => ({ dayIndex: d.dayIndex, ...round(d) })),
    total: round(total),
    perPerson,
    energyDensityKcalPerG: total.weightG > 0 ? Math.round((total.kcal / total.weightG) * 100) / 100 : 0,
    missingFoodIds: [...missing].sort(),
    macroPct: { protein: pct(4 * total.proteinG), carbs: pct(4 * total.carbsG), fat: pct(9 * total.fatG) },
  };
}
