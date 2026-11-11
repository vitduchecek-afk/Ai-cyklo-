import { describe, expect, it } from 'vitest';
import { findSavingOpportunities, knapsack01, optimizeLoadout, solveKnapsack } from '../src/optimizer';
import type { OptimizerCandidate, OptimizerInput } from '../src/optimizer';
import { entry, gear } from './helpers';

const bag = gear({ id: 'bag', name: 'Péřový spacák', weightG: 1400, categoryKey: 'sleeping_bags', comfortTempC: -2 });
const tent = gear({ id: 'tent', name: 'Stan 2P', weightG: 2000, categoryKey: 'tents' });
const jacket = gear({ id: 'jacket', name: 'Nepromokavá bunda', weightG: 450, categoryKey: 'clothing', waterproof: true });
const aid = gear({ id: 'aid', name: 'Lékárnička', weightG: 200, categoryKey: 'first_aid' });
const lamp = gear({ id: 'lamp', name: 'Čelovka', weightG: 90, categoryKey: 'electronics' });
const book = gear({ id: 'book', name: 'Kniha', weightG: 400, categoryKey: 'other' });
const chair = gear({ id: 'chair', name: 'Židlička', weightG: 600, categoryKey: 'other' });
const pinned = gear({ id: 'pin', name: 'Povinný dalekohled', weightG: 500, categoryKey: 'other' });
const essentialOpt = gear({ id: 'ess', name: 'Rádio', weightG: 300, categoryKey: 'electronics', essential: true });
const spork1 = gear({ id: 'sp', name: 'Spork', weightG: 20, categoryKey: 'cooking' });

const base = (): OptimizerInput => ({
  entries: [
    entry(bag),
    entry(tent),
    entry(jacket),
    entry(aid),
    entry(lamp),
    entry(book, 'optional'),
    entry(chair, 'optional'),
    entry(pinned, 'optional'),
    entry(essentialOpt, 'optional'),
    entry(spork1, 'packed', 3),
  ],
  targetBaseWeightG: 3500,
  comfort: 'balanced',
  tripType: 'multi_day',
  expected: { minTempC: 0, rain: true, days: 3 },
  mandatoryItemIds: ['pin'],
});

describe('optimizeLoadout', () => {
  it('never removes essential or mandatory items and reports them', () => {
    const r = optimizeLoadout({ ...base(), comfort: 'minimal', targetBaseWeightG: 100 });
    const touched = r.steps.filter((s) => s.kind !== 'keep').map((s) => s.itemId);
    expect(touched).not.toContain('pin');
    expect(touched).not.toContain('ess');
    expect(touched).not.toContain('aid');
    expect(touched).not.toContain('lamp');
    expect(touched).toContain('book');
    expect(touched).toContain('chair');
    expect(r.blockedBySafety.map((b) => b.itemName)).toEqual(expect.arrayContaining(['Povinný dalekohled', 'Rádio']));
    expect(r.targetReached).toBe(false);
    expect(r.gapG).toBe(r.after.baseG - 100);
    expect(r.advisories.some((a) => a.code === 'optimizer_target_gap')).toBe(true);
  });

  it('removes optional items only until the target is reached when balanced', () => {
    const input = base();
    const before = optimizeLoadout(input).before.baseG;
    const r = optimizeLoadout({ ...input, targetBaseWeightG: before - 300 });
    const removed = r.steps.filter((s) => s.kind === 'remove');
    expect(removed.map((s) => s.itemId)).toEqual(['chair']);
    expect(r.targetReached).toBe(true);
    expect(r.steps.some((s) => s.kind === 'keep' && s.itemId === 'book')).toBe(true);
    expect(r.totalSavedG).toBe(before - r.after.baseG);
  });

  it('reduces redundant quantities of non-critical items', () => {
    const r = optimizeLoadout(base());
    const step = r.steps.find((s) => s.kind === 'reduce_quantity');
    expect(step?.itemId).toBe('sp');
    expect(step?.savedG).toBe(40);
  });

  const cands: OptimizerCandidate[] = [
    { name: 'Quilt -2 °C', categoryKey: 'quilts', weightG: 600, price: 5000, currency: 'CZK', replacesItemId: 'bag', comfortTempC: 0, source: 'user', estimated: false },
    { name: 'Letní quilt 10 °C', categoryKey: 'quilts', weightG: 300, price: 3000, currency: 'CZK', replacesItemId: 'bag', comfortTempC: 10, source: 'user', estimated: false },
    { name: 'Tarp', categoryKey: 'tarps', weightG: 400, price: 1500, currency: 'CZK', replacesItemId: 'tent', source: 'user', estimated: false },
    { name: 'Větrovka', categoryKey: 'clothing', weightG: 100, replacesItemId: 'jacket', waterproof: false, source: 'inventory', estimated: false },
    { name: 'Lehká pláštěnka', categoryKey: 'clothing', weightG: 200, price: 800, currency: 'CZK', replacesItemId: 'jacket', waterproof: true, source: 'reference', estimated: true },
  ];

  it('respects sleep temperature and waterproof safety constraints', () => {
    const r = optimizeLoadout({ ...base(), comfort: 'minimal', candidates: cands });
    const names = r.steps.map((s) => s.replacementName);
    expect(names).not.toContain('Letní quilt 10 °C');
    expect(names).not.toContain('Větrovka');
    expect(names).toContain('Quilt -2 °C');
    expect(r.blockedBySafety.some((b) => b.reason.includes('Letní quilt'))).toBe(true);
    expect(r.blockedBySafety.some((b) => b.reason.includes('Větrovka'))).toBe(true);
  });

  it('stays within budget and maximises grams saved', () => {
    const r = optimizeLoadout({ ...base(), comfort: 'minimal', budget: { amount: 5000, currency: 'CZK' }, candidates: cands });
    expect(r.totalCost).toBeLessThanOrEqual(5000);
    expect(r.withinBudget).toBe(true);
    const reps = r.steps.filter((s) => s.kind === 'replace');
    // quilt saves 800 g for 5000; tarp 1600 g for 1500 + pláštěnka 250 g for 800 = 6.... budget forces the best subset
    const saved = reps.reduce((s, x) => s + x.savedG, 0);
    expect(saved).toBe(1600 + 250);
    expect(reps.every((s) => s.costPerGramSaved !== undefined)).toBe(true);
    expect(reps.find((s) => s.replacementName === 'Tarp')?.costPerGramSaved).toBeCloseTo(1500 / 1600, 6);
  });

  it('flags estimated reference candidates', () => {
    const r = optimizeLoadout({ ...base(), comfort: 'minimal', candidates: cands });
    expect(r.steps.find((s) => s.replacementName === 'Lehká pláštěnka')?.estimated).toBe(true);
  });
});

describe('knapsack', () => {
  it('solves a classic 0/1 case', () => {
    const items = [
      { id: 'a', value: 60, cost: 10 },
      { id: 'b', value: 100, cost: 20 },
      { id: 'c', value: 120, cost: 30 },
    ];
    expect(knapsack01(items, 50).sort()).toEqual(['b', 'c']);
    expect(knapsack01(items, 5)).toEqual([]);
    expect(knapsack01(items, 60).sort()).toEqual(['a', 'b', 'c']);
  });

  it('picks at most one option per group', () => {
    const sol = solveKnapsack(
      [
        [
          { id: '0:0', value: 500, cost: 10 },
          { id: '0:1', value: 800, cost: 25 },
        ],
        [{ id: '1:0', value: 400, cost: 10 }],
      ],
      30,
    );
    expect(sol.value).toBe(900);
    expect(sol.chosen.map((c) => c?.id)).toEqual(['0:0', '1:0']);
  });

  it('is unconstrained with infinite capacity', () => {
    const sol = solveKnapsack([[{ id: 'x', value: 5, cost: 1e6 }]], Infinity);
    expect(sol.value).toBe(5);
  });
});

describe('findSavingOpportunities', () => {
  it('flags heavy big-three items against estimated reference ranges', () => {
    const heavyPack = gear({ id: 'p', name: 'Batoh 65', weightG: 2800, categoryKey: 'packs' });
    const lightPack = gear({ id: 'p2', name: 'Batoh UL', weightG: 700, categoryKey: 'packs' });
    const ops = findSavingOpportunities([entry(heavyPack), entry(lightPack), entry(tent)]);
    expect(ops.map((o) => o.itemId)).toEqual(['p', 'tent']);
    expect(ops.every((o) => o.reference && o.estimated)).toBe(true);
    expect(ops.find((o) => o.itemId === 'p')?.level).toBe('heavy');
  });
});
