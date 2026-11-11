/**
 * Trip budget summary and settle-up. Money is handled in integer minor
 * units (cents) to avoid floating-point drift. Exchange rates are NEVER
 * invented: foreign-currency expenses without `exchangeRate` are excluded
 * and reported in `missingRates`.
 */
import type { Expense, ExpenseCategory } from '@trailpack/shared';
import { invalid, requireInt } from './internal';

export interface BudgetParticipant {
  id: string;
  name: string;
}

export interface BudgetOptions {
  /** Currency of the totals (the trip currency). */
  baseCurrency: string;
  participants: BudgetParticipant[];
  /** Trip length in days (> 0), used for the per-day average. */
  days: number;
}

export interface PersonSummary {
  id: string;
  name: string;
  /** Sum paid by this person (actual expenses), base currency. */
  paid: number;
  /** Person's share of the actual expenses, base currency. */
  share: number;
  /** paid − share counting only expenses with a known payer; positive = is owed money. */
  balance: number;
}

export interface BudgetSummary {
  baseCurrency: string;
  plannedTotal: number;
  actualTotal: number;
  byCategory: Record<ExpenseCategory, { planned: number; actual: number }>;
  perPerson: PersonSummary[];
  /** Average per day. */
  perDay: { planned: number; actual: number };
  /** IDs of expenses excluded because their currency differs and no exchange rate was given. */
  missingRates: string[];
  /** Currencies of the excluded expenses. */
  missingCurrencies: string[];
}

export interface Transfer {
  from: string;
  to: string;
  /** Amount in base currency. */
  amount: number;
}

const CATEGORIES: ExpenseCategory[] = ['transport', 'food', 'lodging', 'fees', 'fuel', 'gear', 'reserve', 'other'];
const toCents = (v: number) => Math.round(v * 100);
const fromCents = (c: number) => c / 100;

interface Converted {
  expense: Expense;
  cents: number;
}

function convert(expenses: readonly Expense[], base: string): { ok: Converted[]; missing: Expense[] } {
  const ok: Converted[] = [];
  const missing: Expense[] = [];
  for (const e of expenses) {
    if (!Number.isFinite(e.amount) || e.amount < 0) invalid(`Neplatná částka výdaje „${e.id}“.`);
    if (e.currency === base) ok.push({ expense: e, cents: toCents(e.amount) });
    else if (e.exchangeRate !== undefined && Number.isFinite(e.exchangeRate) && e.exchangeRate > 0) ok.push({ expense: e, cents: toCents(e.amount * e.exchangeRate) });
    else missing.push(e);
  }
  return { ok, missing };
}

/** Split `cents` into `n` parts that sum exactly (remainder goes to the first parts). */
function splitCents(cents: number, n: number): number[] {
  const base = Math.floor(cents / n);
  const rem = cents - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

function computeBalances(
  converted: readonly Converted[],
  participants: readonly BudgetParticipant[],
): { people: Map<string, { name: string; paid: number; share: number; balance: number }> } {
  const people = new Map<string, { name: string; paid: number; share: number; balance: number }>();
  for (const p of participants) people.set(p.id, { name: p.name, paid: 0, share: 0, balance: 0 });
  const ensure = (id: string) => {
    let p = people.get(id);
    if (!p) {
      p = { name: id, paid: 0, share: 0, balance: 0 };
      people.set(id, p);
    }
    return p;
  };
  for (const { expense, cents } of converted) {
    if (expense.planned) continue;
    const split = expense.splitBetween.length > 0 ? expense.splitBetween : participants.map((p) => p.id);
    if (split.length > 0) {
      const parts = splitCents(cents, split.length);
      split.forEach((id, i) => {
        const p = ensure(id);
        p.share += parts[i]!;
        if (expense.paidBy) p.balance -= parts[i]!;
      });
    }
    if (expense.paidBy) {
      const payer = ensure(expense.paidBy);
      payer.paid += cents;
      payer.balance += cents;
    }
  }
  return { people };
}

/**
 * Summarise planned vs. actual expenses in the base currency.
 * Expenses with `planned: true` count towards `plannedTotal`, the others
 * towards `actualTotal`; shares are computed for actual expenses only.
 */
export function summarizeExpenses(expenses: readonly Expense[], opts: BudgetOptions): BudgetSummary {
  const days = requireInt('days', opts.days, 1, 3650);
  const { ok, missing } = convert(expenses, opts.baseCurrency);
  let planned = 0;
  let actual = 0;
  const byCat = Object.fromEntries(CATEGORIES.map((c) => [c, { planned: 0, actual: 0 }])) as Record<ExpenseCategory, { planned: number; actual: number }>;
  for (const { expense, cents } of ok) {
    const bucket = byCat[expense.category];
    if (expense.planned) {
      planned += cents;
      bucket.planned += cents;
    } else {
      actual += cents;
      bucket.actual += cents;
    }
  }
  for (const c of CATEGORIES) {
    byCat[c] = { planned: fromCents(byCat[c].planned), actual: fromCents(byCat[c].actual) };
  }
  const { people } = computeBalances(ok, opts.participants);
  const perPerson = [...people.entries()].map(([id, p]) => ({
    id,
    name: p.name,
    paid: fromCents(p.paid),
    share: fromCents(p.share),
    balance: fromCents(p.balance),
  }));
  return {
    baseCurrency: opts.baseCurrency,
    plannedTotal: fromCents(planned),
    actualTotal: fromCents(actual),
    byCategory: byCat,
    perPerson,
    perDay: { planned: Math.round(planned / days) / 100, actual: Math.round(actual / days) / 100 },
    missingRates: missing.map((e) => e.id),
    missingCurrencies: [...new Set(missing.map((e) => e.currency))].sort(),
  };
}

/**
 * Minimal set of transfers that settles all balances (greedy matching of the
 * largest creditor with the largest debtor; at most n−1 transfers).
 * @param balances map participant id → balance in base currency (positive = is owed)
 */
export function settleBalances(balances: Record<string, number>): Transfer[] {
  const creditors: Array<{ id: string; c: number }> = [];
  const debtors: Array<{ id: string; c: number }> = [];
  for (const [id, v] of Object.entries(balances)) {
    const c = toCents(v);
    if (c > 0) creditors.push({ id, c });
    else if (c < 0) debtors.push({ id, c: -c });
  }
  const byAmount = (a: { id: string; c: number }, b: { id: string; c: number }) => b.c - a.c || a.id.localeCompare(b.id);
  const out: Transfer[] = [];
  creditors.sort(byAmount);
  debtors.sort(byAmount);
  while (creditors.length > 0 && debtors.length > 0) {
    const cr = creditors[0]!;
    const db = debtors[0]!;
    const amt = Math.min(cr.c, db.c);
    out.push({ from: db.id, to: cr.id, amount: fromCents(amt) });
    cr.c -= amt;
    db.c -= amt;
    if (cr.c === 0) creditors.shift();
    if (db.c === 0) debtors.shift();
    creditors.sort(byAmount);
    debtors.sort(byAmount);
  }
  return out;
}

/**
 * Settle up a group: who pays whom to even out the actual expenses that have
 * a known payer. Foreign-currency expenses without an exchange rate are skipped.
 */
export function settleUp(expenses: readonly Expense[], opts: Pick<BudgetOptions, 'baseCurrency' | 'participants'>): Transfer[] {
  const { ok } = convert(expenses, opts.baseCurrency);
  const { people } = computeBalances(ok, opts.participants);
  const balances: Record<string, number> = {};
  for (const [id, p] of people) balances[id] = fromCents(p.balance);
  return settleBalances(balances);
}
