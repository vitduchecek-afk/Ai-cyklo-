import { describe, expect, it } from 'vitest';
import { TrailPackError } from '@trailpack/shared';
import type { WaterInput } from '../src/water';
import { calculateWaterNeeds } from '../src/water';
import { cyclingEnergy, estimateEnergyExpenditure, recommendedIntakeKcal } from '../src/energy';
import { calculatePowerPlan, coldCapacityFactor, mahToWh } from '../src/power';
import type { PowerDevice } from '../src/power';

describe('calculateWaterNeeds', () => {
  const base: WaterInput = {
    durationH: 8,
    movingH: 6,
    ascentM: 800,
    tempMaxC: 25,
    intensity: 'moderate',
    bodyWeightKg: 75,
    people: 1,
    totalKm: 20,
  };

  it('matches the hand-computed daily need (0.77 l/h x 6 h + 0.16 + 0.28 = 5.06 l)', () => {
    const r = calculateWaterNeeds(base);
    expect(r.drinkingL).toBe(5.1);
    expect(r.cookingL).toBe(0.5);
    expect(r.perPersonL).toBe(5.6);
    // no refill: carry everything + cooking + 15 % reserve = 6.39 l
    expect(r.carryAtStartL).toBe(6.4);
    expect(r.maxCarryL).toBe(6.4);
    expect(r.waterWeightKg).toBe(6.4);
    expect(r.advisories.map((a) => a.code)).toEqual(expect.arrayContaining(['water_no_reliable_source', 'water_load_very_heavy']));
    expect(r.assumptions.join(' ')).toContain('nejde o lékařské doporučení');
  });

  it('plans refills only from non-low-reliability sources and flags treatment', () => {
    const r = calculateWaterNeeds({
      ...base,
      refillPoints: [
        { atKm: 5, name: 'Potok', reliability: 'low', potable: false },
        { atKm: 10, name: 'Studánka', reliability: 'medium', potable: false },
      ],
    });
    expect(r.refillPlan).toEqual([{ atKm: 10, name: 'Studánka', fillToL: 3.5, treat: true }]);
    expect(r.carryAtStartL).toBe(2.9);
    expect(r.maxCarryL).toBe(3.5);
    expect(r.advisories.map((a) => a.code)).toContain('water_treatment_recommended');
    expect(r.advisories.map((a) => a.code)).not.toContain('water_no_reliable_source');
  });

  it('scales with people and days, and with heat', () => {
    const one = calculateWaterNeeds(base);
    const group = calculateWaterNeeds({ ...base, people: 3, days: 2 });
    expect(group.drinkingL).toBeCloseTo(one.drinkingL * 6, 0);
    const hot = calculateWaterNeeds({ ...base, tempMaxC: 33 });
    expect(hot.perPersonL).toBeGreaterThan(one.perPersonL);
    expect(hot.advisories.map((a) => a.code)).toContain('water_heat');
  });

  it('keeps the sweat rate within 0.4–1.0 l/h and handles zero distance', () => {
    const cold = calculateWaterNeeds({ ...base, tempMaxC: -10, intensity: 'low', ascentM: 0, durationH: 6, movingH: 6 });
    expect(cold.drinkingL / 6).toBeGreaterThanOrEqual(0.4 - 1e-9);
    const zero = calculateWaterNeeds({ ...base, totalKm: 0, durationH: 0, movingH: 0, ascentM: 0 });
    expect(zero.drinkingL).toBe(0);
  });

  it('rejects invalid input', () => {
    expect(() => calculateWaterNeeds({ ...base, people: 0 })).toThrow(TrailPackError);
    expect(() => calculateWaterNeeds({ ...base, humidityPct: 150 })).toThrow(TrailPackError);
    expect(() => calculateWaterNeeds({ ...base, movingH: -1 })).toThrow(TrailPackError);
  });
});

describe('energy', () => {
  it('Pandolf flat walk: 75 kg + 10 kg, 4 km in 60 min ≈ 235 kcal', () => {
    const r = estimateEnergyExpenditure({ bodyWeightKg: 75, loadKg: 10, movingMin: 60, distanceM: 4000, ascentM: 0, descentM: 0 });
    expect(r.activityKcal).toBeGreaterThan(233);
    expect(r.activityKcal).toBeLessThan(237);
    expect(r.restingKcal).toBe(1553); // 0.9 * 75 * 23 h
    expect(r.totalKcal).toBe(r.activityKcal + r.restingKcal);
    expect(r.method).toContain('Pandolf');
  });

  it('climbing costs more than flat, descending less than climbing; unknown body weight is stated', () => {
    const flat = estimateEnergyExpenditure({ loadKg: 10, movingMin: 120, distanceM: 8000, ascentM: 0, descentM: 0 });
    const up = estimateEnergyExpenditure({ loadKg: 10, movingMin: 120, distanceM: 8000, ascentM: 600, descentM: 0 });
    const down = estimateEnergyExpenditure({ loadKg: 10, movingMin: 120, distanceM: 8000, ascentM: 0, descentM: 600 });
    expect(up.activityKcal).toBeGreaterThan(flat.activityKcal * 1.2);
    expect(down.activityKcal).toBeLessThan(up.activityKcal);
    expect(down.activityKcal).toBeGreaterThan(0);
    expect(flat.assumptions.join(' ')).toContain('předpokládáno 75 kg');
  });

  it('handles zero movement and invalid input', () => {
    expect(estimateEnergyExpenditure({ loadKg: 0, movingMin: 0, distanceM: 0, ascentM: 0, descentM: 0 }).activityKcal).toBe(0);
    expect(() => estimateEnergyExpenditure({ loadKg: -1, movingMin: 10, distanceM: 1, ascentM: 0, descentM: 0 })).toThrow(TrailPackError);
    expect(() => estimateEnergyExpenditure({ loadKg: 1, movingMin: 10, distanceM: 1, ascentM: 0, descentM: 0, terrainFactor: 0.5 })).toThrow(TrailPackError);
  });

  it('cycling MET: 60 km in 3 h (20 km/h = 8 MET) at 75 kg = 1800 kcal', () => {
    const r = cyclingEnergy({ bodyWeightKg: 75, movingMin: 180, distanceM: 60000 });
    expect(r.activityKcal).toBe(1800);
    const hilly = cyclingEnergy({ bodyWeightKg: 75, movingMin: 180, distanceM: 30000, ascentM: 2000 });
    expect(hilly.activityKcal).toBeGreaterThan(1500);
    expect(() => cyclingEnergy({ movingMin: -1, distanceM: 1 })).toThrow(TrailPackError);
  });

  it('recommends an orientational intake range', () => {
    const r = recommendedIntakeKcal(3000);
    expect(r.minKcal).toBe(2550);
    expect(r.maxKcal).toBe(3000);
    expect(r.note).toContain('Orientační');
    expect(() => recommendedIntakeKcal(-1)).toThrow(TrailPackError);
  });
});

describe('power', () => {
  const phone: PowerDevice = { name: 'Telefon', type: 'phone', capacityMah: 4000, drainPctPerHour: 5, hoursPerDay: 3, standbyPctPerDay: 4 };
  const gps: PowerDevice = { name: 'GPS', type: 'gps', capacityWh: 10, drawW: 0.5, hoursPerDay: 10 };

  it('converts mAh to Wh and derates for cold', () => {
    expect(mahToWh(10000)).toBeCloseTo(37, 6);
    expect(mahToWh(5000, 3.85)).toBeCloseTo(19.25, 6);
    expect(coldCapacityFactor(-10)).toBe(0.8);
    expect(coldCapacityFactor(0)).toBe(0.9);
    expect(coldCapacityFactor(-5)).toBeCloseTo(0.85, 6);
    expect(coldCapacityFactor(25)).toBe(1);
    expect(coldCapacityFactor(-50)).toBe(0.5);
  });

  it('needs no power bank when the device battery is enough', () => {
    const p = calculatePowerPlan({ days: 3, devices: [phone], powerbanks: [] });
    expect(p.perDevice[0]!.dailyWh).toBeCloseTo(2.8, 1); // 0.05*14.8*3 + 4 % standby
    expect(p.perDevice[0]!.fromPowerbankWh).toBe(0);
    expect(p.neededWh).toBe(0);
    expect(p.sufficient).toBe(true);
    expect(p.recommendedPowerbankMah).toBe(0);
    expect(p.reservePct).toBe(100);
  });

  it('computes need, reserve and recommendation with charging losses', () => {
    const p = calculatePowerPlan({ days: 4, devices: [gps], powerbanks: [{ name: 'PB', capacityMah: 10000 }] });
    // 5 Wh/day x 4 = 20 Wh; own battery 8 Wh; 12 Wh from bank / 0.65 = 18.46 Wh
    expect(p.perDevice[0]).toMatchObject({ tripWh: 20, fromOwnBatteryWh: 8, fromPowerbankWh: 12 });
    expect(p.neededWh).toBeCloseTo(18.5, 1);
    expect(p.availableWh).toBe(37);
    expect(p.sufficient).toBe(true);
    expect(p.recommendedPowerbankMah).toBe(10000);
    expect(p.dayByDay).toHaveLength(4);
    expect(p.dayByDay[3]!.powerbankRemainingWh).toBeCloseTo(18.5, 1);
    expect(p.savingTips.length).toBeGreaterThan(0);
  });

  it('applies cold derating and reports a shortfall', () => {
    const cold = calculatePowerPlan({ days: 4, devices: [gps], powerbanks: [{ name: 'PB', capacityMah: 10000 }], minTempC: -10 });
    expect(cold.availableWh).toBeCloseTo(29.6, 1);
    expect(cold.neededWh).toBeCloseTo(20.9, 1);
    expect(cold.advisories.map((a) => a.code)).toContain('power_cold_derating');
    const none = calculatePowerPlan({ days: 4, devices: [gps], powerbanks: [] });
    expect(none.sufficient).toBe(false);
    expect(none.advisories.find((a) => a.code === 'power_shortfall')!.severity).toBe('danger');
    expect(none.dayByDay.at(-1)!.powerbankRemainingWh).toBeLessThan(0);
  });

  it('recharges at outlet days (zero-based) and recommends multiples above 26800 mAh', () => {
    const p = calculatePowerPlan({ days: 4, devices: [gps], powerbanks: [{ name: 'PB', capacityMah: 10000 }], outletDays: [1] });
    expect(p.neededWh).toBeCloseTo(3.1, 1);
    expect(p.dayByDay.map((d) => d.powerbankRemainingWh)).toEqual([37, 37, 37, 33.9]);
    const big = calculatePowerPlan({ days: 20, devices: [{ ...gps, drawW: 5 }], powerbanks: [] });
    expect(big.recommendedPowerbankMah % 26800).toBe(0);
    expect(big.recommendedPowerbankMah).toBeGreaterThan(26800);
  });

  it('flags missing device data and over-100-Wh banks, and rejects invalid input', () => {
    const p = calculatePowerPlan({ days: 2, devices: [{ name: 'Záhada', type: 'other', hoursPerDay: 2 }], powerbanks: [{ name: 'Velká', capacityMah: 30000 }] });
    expect(p.advisories.map((a) => a.code)).toEqual(expect.arrayContaining(['power_device_data_missing', 'powerbank_over_100wh']));
    expect(() => calculatePowerPlan({ days: 0, devices: [], powerbanks: [] })).toThrow(TrailPackError);
    expect(() => calculatePowerPlan({ days: 1, devices: [], powerbanks: [], chargingEfficiency: 0.1 })).toThrow(TrailPackError);
    expect(() => calculatePowerPlan({ days: 1, devices: [{ ...gps, hoursPerDay: 30 }], powerbanks: [] })).toThrow(TrailPackError);
  });
});
