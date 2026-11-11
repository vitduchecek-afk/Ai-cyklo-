import { describe, expect, it } from 'vitest';
import { ExpenseSchema, GPSActivitySchema, RouteSchema, TripSchema, TrailPackError } from '@trailpack/shared';
import type { Expense } from '@trailpack/shared';
import { settleBalances, settleUp, summarizeExpenses } from '../src/budget';
import { activityHeatmap, computeStatistics } from '../src/stats';

const T = '2026-05-01T10:00:00.000Z';
const base = { createdAt: T, updatedAt: T };
const expense = (o: Partial<Expense> & Pick<Expense, 'id' | 'category' | 'amount' | 'currency'>): Expense =>
  ExpenseSchema.parse({ ...base, tripId: 't1', ...o });

const participants = [
  { id: 'a', name: 'Anna' },
  { id: 'b', name: 'Boris' },
  { id: 'c', name: 'Cyril' },
];
const expenses: Expense[] = [
  expense({ id: 'e1', category: 'food', amount: 300, currency: 'CZK', paidBy: 'a' }),
  expense({ id: 'e2', category: 'lodging', amount: 600, currency: 'CZK', paidBy: 'b', splitBetween: ['a', 'b'] }),
  expense({ id: 'e3', category: 'fees', amount: 20, currency: 'EUR', paidBy: 'a' }),
  expense({ id: 'e4', category: 'food', amount: 10, currency: 'EUR', exchangeRate: 25, paidBy: 'c' }),
  expense({ id: 'e5', category: 'transport', amount: 1000, currency: 'CZK', planned: true }),
];

describe('summarizeExpenses', () => {
  const s = summarizeExpenses(expenses, { baseCurrency: 'CZK', participants, days: 5 });

  it('totals planned and actual, converting only with a given rate', () => {
    expect(s.plannedTotal).toBe(1000);
    expect(s.actualTotal).toBe(1150);
    expect(s.byCategory.food).toEqual({ planned: 0, actual: 550 });
    expect(s.byCategory.lodging.actual).toBe(600);
    expect(s.perDay).toEqual({ planned: 200, actual: 230 });
  });

  it('never invents rates: foreign expenses without a rate are excluded and listed', () => {
    expect(s.missingRates).toEqual(['e3']);
    expect(s.missingCurrencies).toEqual(['EUR']);
    expect(s.byCategory.fees.actual).toBe(0);
  });

  it('splits cent-exactly per person', () => {
    const byId = Object.fromEntries(s.perPerson.map((p) => [p.id, p]));
    expect(byId.a).toMatchObject({ paid: 300, share: 483.34, balance: -183.34 });
    expect(byId.b).toMatchObject({ paid: 600, share: 483.33, balance: 116.67 });
    expect(byId.c).toMatchObject({ paid: 250, share: 183.33, balance: 66.67 });
    expect(s.perPerson.reduce((acc, p) => acc + p.share, 0)).toBeCloseTo(1150, 6);
  });

  it('handles empty input and rejects bad day counts / amounts', () => {
    const empty = summarizeExpenses([], { baseCurrency: 'CZK', participants: [], days: 1 });
    expect(empty.actualTotal).toBe(0);
    expect(empty.perPerson).toEqual([]);
    expect(() => summarizeExpenses([], { baseCurrency: 'CZK', participants, days: 0 })).toThrow(TrailPackError);
    const bad = { ...expenses[0]!, amount: -5 };
    expect(() => summarizeExpenses([bad], { baseCurrency: 'CZK', participants, days: 1 })).toThrow(TrailPackError);
  });
});

describe('settleUp', () => {
  it('produces minimal transfers that zero all balances', () => {
    const t = settleUp(expenses, { baseCurrency: 'CZK', participants });
    expect(t).toEqual([
      { from: 'a', to: 'b', amount: 116.67 },
      { from: 'a', to: 'c', amount: 66.67 },
    ]);
  });

  it('settles balances with at most n-1 transfers', () => {
    const t = settleBalances({ a: 50, b: -20, c: -30, d: 0 });
    expect(t).toEqual([
      { from: 'c', to: 'a', amount: 30 },
      { from: 'b', to: 'a', amount: 20 },
    ]);
    expect(settleBalances({ a: 0, b: 0 })).toEqual([]);
  });

  it('ignores expenses without payer and returns nothing when already even', () => {
    const even = [expense({ id: 'x', category: 'food', amount: 100, currency: 'CZK', paidBy: 'a', splitBetween: ['a'] })];
    expect(settleUp(even, { baseCurrency: 'CZK', participants })).toEqual([]);
    const noPayer = [expense({ id: 'y', category: 'food', amount: 90, currency: 'CZK' })];
    expect(settleUp(noPayer, { baseCurrency: 'CZK', participants })).toEqual([]);
  });
});

describe('computeStatistics', () => {
  const trip = (o: Record<string, unknown>) => TripSchema.parse({ ...base, name: 'Výlet', ...o });
  const act = (o: Record<string, unknown>) => GPSActivitySchema.parse({ ...base, name: 'Nahrávka', ...o });
  const geometry = [
    [14, 50],
    [14.1, 50.1],
  ];
  const route = RouteSchema.parse({ ...base, id: 'r1', name: 'Trasa', source: 'manual', geometry, distanceM: 15000, ascentM: 300, descentM: 300 });

  const trips = [
    trip({ id: 't1', status: 'completed', startDate: '2026-05-10', endDate: '2026-05-12', region: 'Krkonoše' }),
    trip({ id: 't2', status: 'completed', startDate: '2026-06-01', endDate: '2026-06-01', region: 'Jeseníky', routeId: 'r1' }),
    trip({ id: 't3', status: 'planning', startDate: '2026-07-01' }),
  ];
  const activities = [
    act({ id: 'a1', tripId: 't1', status: 'finished', startedAt: '2026-05-10T08:00:00.000Z', distanceM: 10000, ascentM: 500 }),
    act({ id: 'a2', status: 'finished', startedAt: '2026-05-20T08:00:00.000Z', distanceM: 20000, ascentM: 1000, name: 'Dlouhá' }),
    act({ id: 'a3', status: 'recording', startedAt: '2026-05-21T08:00:00.000Z', distanceM: 99000, ascentM: 9000 }),
  ];

  it('aggregates finished activities and falls back to the planned route', () => {
    const s = computeStatistics({ trips, activities, routes: [route] });
    expect(s.totals.distanceKm).toBe(45);
    expect(s.totals.ascentM).toBe(1800);
    expect(s.totals.trips).toBe(3);
    expect(s.totals.completedTrips).toBe(2);
    expect(s.totals.daysOutside).toBe(5);
    expect(s.totals.nightsOutside).toBe(2);
    expect(s.totals.longest?.name).toBe('Dlouhá');
    expect(s.totals.hardest?.effortKm).toBe(30);
    expect(s.totals.visitedPlaces).toEqual(['Jeseníky', 'Krkonoše']);
    expect(s.byMonth).toEqual([
      { month: '2026-05', distanceKm: 30, ascentM: 1500, activities: 2, days: 2 },
      { month: '2026-06', distanceKm: 15, ascentM: 300, activities: 1, days: 1 },
    ]);
    expect(s.byYear).toEqual([{ year: 2026, distanceKm: 45, ascentM: 1800, activities: 3, days: 3 }]);
    expect(s.notes.join(' ')).toContain('plánovaná trasa');
  });

  it('computes base weight average and trend', () => {
    const s = computeStatistics({
      trips: [],
      activities: [],
      routes: [],
      loadoutWeightsG: [
        { date: '2026-03-01', baseG: 7000 },
        { date: '2026-01-01', baseG: 8000 },
        { date: '2026-05-01', baseG: 6000 },
      ],
    });
    expect(s.avgBaseWeightG).toBe(7000);
    expect(s.weightTrend.points[0]!.date).toBe('2026-01-01');
    expect(s.weightTrend).toMatchObject({ deltaG: -2000, direction: 'down' });
  });

  it('handles empty input', () => {
    const s = computeStatistics({ trips: [], activities: [], routes: [] });
    expect(s.totals).toMatchObject({ distanceKm: 0, daysOutside: 0, nightsOutside: 0, longest: null, hardest: null });
    expect(s.avgBaseWeightG).toBeNull();
    expect(s.weightTrend.direction).toBe('unknown');
  });
});

describe('activityHeatmap', () => {
  it('counts per day with levels and ignores invalid dates', () => {
    const h = activityHeatmap(['2026-05-03', '2026-05-01', '2026-05-01T10:00:00Z', 'bad', '2026-13-45']);
    expect(h).toEqual([
      { date: '2026-05-01', count: 2, level: 4 },
      { date: '2026-05-03', count: 1, level: 2 },
    ]);
    expect(activityHeatmap([])).toEqual([]);
  });
});
