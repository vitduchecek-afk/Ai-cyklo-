import { describe, expect, it } from 'vitest';
import { BUILTIN_FOODS, BUILTIN_FOOD_NOTICE, getBuiltinFood, normalizeAllergen } from '../src/foods';
import { mealPlanTotals } from '../src/totals';
import { generateMealPlan } from '../src/planner';
import { BASE_FUEL_PER_LITRE, chooseCanisters, coldGasFactor, estimateFuel } from '../src/fuel';

describe('BUILTIN_FOODS', () => {
  it('has ~50 unique, flagged, plausible foods', () => {
    expect(BUILTIN_FOODS.length).toBeGreaterThanOrEqual(48);
    expect(new Set(BUILTIN_FOODS.map((f) => f.id)).size).toBe(BUILTIN_FOODS.length);
    for (const f of BUILTIN_FOODS) {
      expect(f.id.startsWith('builtin:')).toBe(true);
      expect(f.source).toBe('builtin_typical');
      expect(f.priceEstimated).toBe(true);
      expect(f.notice).toBe(BUILTIN_FOOD_NOTICE);
      const per100 = (f.energyKcal / f.weightG) * 100;
      expect(per100).toBeGreaterThanOrEqual(0);
      expect(per100).toBeLessThanOrEqual(900);
      // macro energy within 25 % of declared energy for non-trivial foods
      if (f.energyKcal > 50) {
        const macro = 4 * f.proteinG + 4 * f.carbsG + 9 * f.fatG;
        expect(Math.abs(macro - f.energyKcal) / f.energyKcal).toBeLessThan(0.25);
      }
    }
  });
  it('has the documented reference values', () => {
    const oats = getBuiltinFood('builtin:oats-500g')!;
    expect(oats.energyKcal).toBe(1850);
    expect(oats.allergens).toContain('gluten');
    expect(oats.coldSoakable).toBe(true);
    expect(getBuiltinFood('builtin:peanut-butter-340g')!.energyKcal).toBe(2040);
    expect(getBuiltinFood('builtin:olive-oil-250ml')!.fatG).toBeCloseTo(230, 0);
  });
  it('normalizes Czech allergen names', () => {
    expect(normalizeAllergen('Mléko')).toBe('milk');
    expect(normalizeAllergen('lepek')).toBe('gluten');
    expect(normalizeAllergen('Ořechy')).toBe('nuts');
  });
});

describe('mealPlanTotals', () => {
  it('sums per day, per person and macros', () => {
    const oats = getBuiltinFood('builtin:oats-500g')!;
    const rice = getBuiltinFood('builtin:rice-500g')!;
    const t = mealPlanTotals(
      {
        days: 2,
        people: 2,
        entries: [
          { dayIndex: 0, meal: 'breakfast', foodItemId: oats.id, quantity: 0.5 },
          { dayIndex: 0, meal: 'dinner', foodItemId: rice.id, quantity: 0.2 },
          { dayIndex: 1, meal: 'dinner', foodItemId: rice.id, quantity: 0.2 },
          { dayIndex: 1, meal: 'lunch', foodItemId: 'builtin:ghost', quantity: 1 },
        ],
      },
      BUILTIN_FOODS,
    );
    expect(t.perDay).toHaveLength(2);
    expect(t.perDay[0]?.kcal).toBe(Math.round(oats.energyKcal * 0.5 + rice.energyKcal * 0.2));
    expect(t.perDay[0]?.weightG).toBe(250 + 100);
    expect(t.perDay[0]?.waterMl).toBe(Math.round(oats.waterMl * 0.5 + rice.waterMl * 0.2));
    expect(t.perDay[0]?.cookMinutes).toBe(5 + 15);
    expect(t.perDay[1]?.cookMinutes).toBe(15);
    expect(t.total.kcal).toBe(t.perDay[0]!.kcal + t.perDay[1]!.kcal);
    expect(t.perPerson.kcal).toBe(Math.round(t.total.kcal / 2));
    expect(t.missingFoodIds).toEqual(['builtin:ghost']);
    expect(t.macroPct.protein + t.macroPct.carbs + t.macroPct.fat).toBeGreaterThan(99);
    expect(t.macroPct.protein + t.macroPct.carbs + t.macroPct.fat).toBeLessThan(101);
    expect(t.energyDensityKcalPerG).toBeCloseTo(t.total.kcal / t.total.weightG, 1);
  });
});

describe('generateMealPlan', () => {
  const base = { days: 5, people: 2, targetKcalPerDay: 2800, foods: BUILTIN_FOODS, cooking: 'gas' as const };

  it('hits the energy target within ±10 % every day', () => {
    const r = generateMealPlan(base);
    expect(Math.abs(r.achievedKcalPerDay - 2800) / 2800).toBeLessThan(0.1);
    const t = mealPlanTotals(r.plan, BUILTIN_FOODS);
    for (const d of t.perDay) {
      // the last day also carries the reserve
      if (d.dayIndex < 4) expect(Math.abs(d.kcal / 2 - 2800) / 2800).toBeLessThan(0.1);
    }
    expect(r.plan.entries.some((e) => e.meal === 'reserve' && e.dayIndex === 4)).toBe(true);
    expect(r.plan.entries.every((e) => !e.meal.includes('drink'))).toBe(true);
    for (const m of ['breakfast', 'snack', 'lunch', 'dinner']) expect(r.plan.entries.some((e) => e.meal === m)).toBe(true);
    expect(r.warnings.some((w) => w.includes('typické'))).toBe(true);
  });

  it('is deterministic per seed and varies between seeds', () => {
    const a = generateMealPlan({ ...base, seed: 7 });
    const b = generateMealPlan({ ...base, seed: 7 });
    const c = generateMealPlan({ ...base, seed: 8 });
    expect(a.plan.entries).toEqual(b.plan.entries);
    expect(JSON.stringify(a.plan.entries)).not.toBe(JSON.stringify(c.plan.entries));
  });

  it('never uses excluded allergens or violates diet', () => {
    const r = generateMealPlan({ ...base, excludeAllergens: ['milk', 'lepek', 'arašídy', 'nuts'], diet: ['vegan'] });
    const byId = new Map(BUILTIN_FOODS.map((f) => [f.id, f]));
    expect(r.plan.entries.length).toBeGreaterThan(10);
    for (const e of r.plan.entries) {
      const f = byId.get(e.foodItemId)!;
      expect(f.allergens).not.toContain('milk');
      expect(f.allergens).not.toContain('gluten');
      expect(f.allergens).not.toContain('peanuts');
      expect(f.allergens).not.toContain('nuts');
      expect(f.diet).toContain('vegan');
    }
    expect(r.plan.dietRestrictions).toContain('vegan');
    expect(Math.abs(r.achievedKcalPerDay - 2800) / 2800).toBeLessThan(0.1);
  });

  it('respects cooking mode', () => {
    const none = generateMealPlan({ ...base, cooking: 'none' });
    const byId = new Map(BUILTIN_FOODS.map((f) => [f.id, f]));
    expect(none.plan.entries.every((e) => !byId.get(e.foodItemId)!.requiresCooking)).toBe(true);
    const cold = generateMealPlan({ ...base, cooking: 'cold_soak' });
    expect(cold.plan.entries.every((e) => !byId.get(e.foodItemId)!.requiresCooking || byId.get(e.foodItemId)!.coldSoakable)).toBe(true);
    const alc = generateMealPlan({ ...base, cooking: 'alcohol' });
    expect(alc.plan.entries.every((e) => byId.get(e.foodItemId)!.cookMinutes <= 10)).toBe(true);
  });

  it('handles partial first and last days, no reserve, and light preference', () => {
    const r = generateMealPlan({ ...base, days: 3, includeReserve: false, firstDayMeals: ['lunch', 'dinner'], lastDayMeals: ['breakfast'] });
    expect(r.plan.entries.some((e) => e.meal === 'reserve')).toBe(false);
    expect(r.plan.entries.filter((e) => e.dayIndex === 0).every((e) => e.meal === 'lunch' || e.meal === 'dinner')).toBe(true);
    expect(r.plan.entries.filter((e) => e.dayIndex === 2).every((e) => e.meal === 'breakfast')).toBe(true);
    expect(Math.abs(r.achievedKcalPerDay - r.expectedKcalPerDay) / r.expectedKcalPerDay).toBeLessThan(0.1);

    const heavy = mealPlanTotals(generateMealPlan({ ...base, seed: 3 }).plan, BUILTIN_FOODS).energyDensityKcalPerG;
    const light = mealPlanTotals(generateMealPlan({ ...base, seed: 3, preferLight: true }).plan, BUILTIN_FOODS).energyDensityKcalPerG;
    expect(light).toBeGreaterThanOrEqual(heavy);
  });

  it('warns when nothing fits and rejects invalid input', () => {
    const r = generateMealPlan({ ...base, foods: BUILTIN_FOODS.filter((f) => f.id === 'builtin:oats-500g'), diet: ['vegan'], excludeAllergens: ['gluten'] });
    expect(r.plan.entries).toHaveLength(0);
    expect(r.warnings[0]).toMatch(/Žádná potravina/);
    expect(() => generateMealPlan({ ...base, days: 0 })).toThrow();
    expect(() => generateMealPlan({ ...base, targetKcalPerDay: 100 })).toThrow();
  });

  it('reports budget overrun', () => {
    const r = generateMealPlan({ ...base, budgetPerDay: 5 });
    expect(r.warnings.some((w) => w.includes('rozpočet'))).toBe(true);
  });
});

describe('estimateFuel', () => {
  it('uses ~11 g gas per litre at 20 °C calm', () => {
    const f = estimateFuel({ stove: 'gas', boils: [{ waterMl: 1000 }] });
    expect(f.fuelG).toBeCloseTo(BASE_FUEL_PER_LITRE.gas + 0.5, 5);
    expect(f.unit).toBe('g');
    expect(f.withReserve).toBeGreaterThanOrEqual(f.amount * 1.2);
    expect(f.assumptions.join(' ')).toMatch(/10–12 g/);
  });
  it('scales with water, simmer time and heat exchanger', () => {
    const a = estimateFuel({ stove: 'gas', boils: [{ waterMl: 2000 }] });
    expect(a.fuelG).toBeCloseTo(2 * 11 + 0.5, 5);
    const s = estimateFuel({ stove: 'gas', boils: [{ waterMl: 1000, simmerMin: 10 }] });
    expect(s.fuelG).toBeCloseTo(11 + 8 + 0.5, 5);
    const hx = estimateFuel({ stove: 'gas', boils: [{ waterMl: 1000 }], heatExchanger: true });
    expect(hx.fuelG).toBeCloseTo(8.5, 5);
  });
  it('derives water from meals, people and days', () => {
    const f = estimateFuel({ stove: 'gas', days: 3, people: 2, mealsPerDay: 2, waterMlPerMeal: 500, hotDrinksPerDay: 1 });
    expect(f.totalWaterMl).toBe(3 * 2 * (1000 + 250));
  });
  it('adds cold and wind penalties', () => {
    const calm = estimateFuel({ stove: 'gas', boils: [{ waterMl: 1000 }] });
    const cold = estimateFuel({ stove: 'gas', boils: [{ waterMl: 1000 }], ambientTempC: -10 });
    expect(cold.amount).toBeGreaterThan(calm.amount * 1.5);
    expect(cold.uncertaintyPct).toBeGreaterThan(calm.uncertaintyPct);
    expect(coldGasFactor(-10)).toBeCloseTo(1.6, 5);
    const wind = estimateFuel({ stove: 'gas', boils: [{ waterMl: 1000 }], windy: true });
    const screen = estimateFuel({ stove: 'gas', boils: [{ waterMl: 1000 }], windy: true, windscreen: true });
    expect(wind.amount / calm.amount).toBeGreaterThan(1.5);
    expect(wind.amount / calm.amount).toBeLessThan(2.05);
    expect(screen.amount).toBeLessThan(wind.amount);
  });
  it('uses ml for alcohol and liquid stoves', () => {
    const al = estimateFuel({ stove: 'alcohol', boils: [{ waterMl: 1000 }] });
    expect(al.unit).toBe('ml');
    expect(al.fuelMl).toBeCloseTo(27.5, 5);
    expect(al.fuelG).toBeUndefined();
    expect(al.recommendedCanisters).toBeUndefined();
    const li = estimateFuel({ stove: 'liquid', boils: [{ waterMl: 1000 }] });
    expect(li.fuelMl).toBeCloseTo(26, 5);
  });
  it('recommends canisters covering the reserve amount', () => {
    const f = estimateFuel({ stove: 'gas', days: 7, people: 2 });
    const cap = f.recommendedCanisters!.reduce((s, c) => s + c.sizeG * c.count, 0);
    expect(cap * 0.9).toBeGreaterThanOrEqual(f.withReserve);
    expect(chooseCanisters(50, 0.9).items).toEqual([{ sizeG: 100, count: 1 }]);
    expect(chooseCanisters(200, 0.9).items).toEqual([{ sizeG: 230, count: 1 }]);
  });
});
