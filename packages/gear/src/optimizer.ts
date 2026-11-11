/**
 * Deterministic ultralight optimizer.
 *
 * Order of operations (no randomness, no AI):
 *  1. redundant pieces (duplicates / quantity > 1 of non-critical items) are reduced,
 *  2. `optional` items are removed (all for `minimal` comfort, else only until the target is met),
 *  3. replacements are chosen with a multiple-choice 0/1 knapsack that maximises grams saved
 *     under the budget (balanced / comfort trim paid swaps that are not needed to reach the target).
 *
 * Safety rules are hard constraints: essential and mandatory items are never removed
 * or replaced; shelter, sleep system, first aid, light, navigation, water treatment, rain
 * shell and emergency items are never removed; a sleeping bag / quilt replacement must have a
 * comfort temperature ≤ expected minimum + 3 °C; with expected rain the shell must stay
 * waterproof.
 */
import type { ActivityType, Advisory, CarryMode, GearItem } from '@trailpack/shared';
import { calculatePackWeight, type GearEntry, type PackWeight } from './weight';
import { GEAR_ROLE_LABELS_CS, gearRole, isProtectedRole, type GearRole } from './roles';
import { matchesAnyKeyword, normalizeText } from './text';

export type ComfortLevel = 'minimal' | 'balanced' | 'comfort';

export interface OptimizerCandidate {
  name: string;
  categoryKey: string;
  /** Weight of ONE piece, grams. */
  weightG: number;
  /** Purchase price per piece in `currency`; ignored (cost 0) for `inventory` candidates. */
  price?: number;
  currency?: string;
  /** Id of the gear item this candidate replaces; when omitted the heaviest eligible item of the same category is used. */
  replacesItemId?: string;
  /** Sleeping bags / quilts: EN/ISO comfort temperature, °C. */
  comfortTempC?: number;
  waterproof?: boolean;
  source: 'inventory' | 'user' | 'reference';
  /** True when weight/price are estimates, not measured/confirmed. */
  estimated: boolean;
}

export interface OptimizerInput {
  entries: readonly GearEntry[];
  targetBaseWeightG: number;
  budget?: { amount: number; currency: string };
  comfort: ComfortLevel;
  tripType: ActivityType;
  expected: { minTempC?: number; rain?: boolean; wind?: boolean; days?: number };
  mandatoryItemIds?: readonly string[];
  candidates?: readonly OptimizerCandidate[];
}

export type OptimizerStepKind = 'remove' | 'replace' | 'reduce_quantity' | 'keep';

export interface OptimizerStep {
  kind: OptimizerStepKind;
  itemId: string;
  itemName: string;
  replacementName?: string;
  /** Grams saved on the base weight. */
  savedG: number;
  /** Purchase cost in budget currency. */
  cost?: number;
  costPerGramSaved?: number;
  /** Czech explanation. */
  reason: string;
  comfortTradeoff?: string;
  safetyNote?: string;
  /** Weight or price based on an estimate. */
  estimated: boolean;
}

export interface OptimizerResult {
  before: PackWeight;
  after: PackWeight;
  steps: OptimizerStep[];
  totalSavedG: number;
  totalCost: number;
  withinBudget: boolean;
  targetReached: boolean;
  /** Grams still above the target (0 when reached). */
  gapG: number;
  blockedBySafety: Array<{ itemName: string; reason: string }>;
  advisories: Advisory[];
}

// ---------------------------------------------------------------------------
// Knapsack
// ---------------------------------------------------------------------------

export interface KnapsackOption {
  id: string;
  /** Grams saved. */
  value: number;
  cost: number;
}

export interface KnapsackSolution {
  /** Chosen option per group (null = nothing chosen). */
  chosen: Array<KnapsackOption | null>;
  value: number;
  cost: number;
}

/**
 * Multiple-choice 0/1 knapsack: from each group at most one option may be taken;
 * maximise total value with total cost ≤ capacity. Groups with a single option
 * form the classic 0/1 knapsack. `capacity = Infinity` picks the best option per group.
 * Deterministic: ties prefer the cheaper, then the earlier option.
 */
export function solveKnapsack(groups: ReadonlyArray<readonly KnapsackOption[]>, capacity: number): KnapsackSolution {
  const sorted = groups.map((g) => [...g].filter((o) => o.value > 0 && o.cost >= 0).sort((a, b) => a.cost - b.cost || b.value - a.value || a.id.localeCompare(b.id)));
  if (!Number.isFinite(capacity)) {
    const chosen = sorted.map((g) => g.reduce<KnapsackOption | null>((best, o) => (best === null || o.value > best.value ? o : best), null));
    return summarize(chosen);
  }
  const cap = Math.max(0, Math.floor(capacity));
  const unit = Math.max(1, Math.ceil(cap / 4000));
  const C = Math.floor(cap / unit);
  const n = sorted.length;
  // dp[g][c]: best value using the first g groups with scaled cost ≤ c
  const dp: Float64Array[] = [new Float64Array(C + 1)];
  const pick: Int32Array[] = [];
  for (let g = 0; g < n; g++) {
    const prev = dp[g]!;
    const cur = Float64Array.from(prev);
    const pk = new Int32Array(C + 1).fill(-1);
    const opts = sorted[g]!;
    for (let c = 0; c <= C; c++) {
      for (let k = 0; k < opts.length; k++) {
        const o = opts[k]!;
        const w = Math.ceil(o.cost / unit);
        if (w > c) continue;
        const v = prev[c - w]! + o.value;
        if (v > cur[c]!) {
          cur[c] = v;
          pk[c] = k;
        }
      }
    }
    dp.push(cur);
    pick.push(pk);
  }
  const chosen: Array<KnapsackOption | null> = new Array<KnapsackOption | null>(n).fill(null);
  let c = C;
  for (let g = n - 1; g >= 0; g--) {
    const k = pick[g]![c]!;
    if (k >= 0) {
      const o = sorted[g]![k]!;
      chosen[g] = o;
      c -= Math.ceil(o.cost / unit);
    }
  }
  return summarize(chosen);
}

function summarize(chosen: Array<KnapsackOption | null>): KnapsackSolution {
  let value = 0;
  let cost = 0;
  for (const o of chosen) {
    if (o) {
      value += o.value;
      cost += o.cost;
    }
  }
  return { chosen, value, cost };
}

/** Classic 0/1 knapsack on a flat list; returns the ids of the chosen items. */
export function knapsack01(items: readonly KnapsackOption[], capacity: number): string[] {
  return solveKnapsack(
    items.map((i) => [i]),
    capacity,
  )
    .chosen.filter((o): o is KnapsackOption => o !== null)
    .map((o) => o.id);
}

// ---------------------------------------------------------------------------
// Optimizer
// ---------------------------------------------------------------------------

const adv = (
  code: string,
  severity: Advisory['severity'],
  message: string,
  extra: Partial<Pick<Advisory, 'params' | 'basis' | 'action' | 'uncertainty'>> = {},
): Advisory => ({ code, severity, message, params: extra.params ?? {}, basis: extra.basis ?? [], action: extra.action, uncertainty: extra.uncertainty, source: 'trailpack:gear-optimizer' });

const DAY_TRIPS: readonly ActivityType[] = ['day_hike', 'road_cycling', 'gravel', 'mtb', 'xc'];
/** Categories where holding more than one piece is normal. */
const MULTI_OK = new Set(['clothing', 'food', 'water', 'footwear']);

const fmtG = (g: number): string => `${Math.round(g)} g`;

function isEstimatedItem(item: GearItem): boolean {
  return !item.weightConfirmed || item.weightSource === 'estimate' || item.weightSource === 'ai_estimate';
}

function withReplacement(item: GearItem, c: OptimizerCandidate): GearItem {
  return {
    ...item,
    name: c.name,
    categoryKey: c.categoryKey,
    weightG: c.weightG,
    weightSource: c.estimated ? 'estimate' : 'manufacturer',
    weightConfirmed: !c.estimated,
    comfortTempC: c.comfortTempC ?? item.comfortTempC,
    waterproof: c.waterproof ?? item.waterproof,
    essential: item.essential,
  };
}

interface Row {
  idx: number;
  e: GearEntry;
  role: GearRole | undefined;
  /** essential flag or mandatory list: never touched. */
  locked: boolean;
}

/** Run the optimizer. Pure and deterministic. */
export function optimizeLoadout(input: OptimizerInput): OptimizerResult {
  const mandatory = new Set(input.mandatoryItemIds ?? []);
  const rows: Row[] = input.entries.map((e, idx) => ({
    idx,
    e,
    role: gearRole(e.item),
    locked: e.item.essential || mandatory.has(e.item.id),
  }));
  const before = calculatePackWeight(input.entries);
  const steps: OptimizerStep[] = [];
  const blocked: Array<{ itemName: string; reason: string }> = [];
  const advisories: Advisory[] = [];
  const removed = new Set<number>();
  const qtyOverride = new Map<number, number>();
  const replaced = new Map<number, OptimizerCandidate>();
  const dayTrip = DAY_TRIPS.includes(input.tripType) && (input.expected.days ?? 1) <= 1;
  const minTemp = input.expected.minTempC;

  const inBase = (r: Row): boolean => r.e.entry.carryMode === 'packed' || r.e.entry.carryMode === 'optional';
  let runningBase = before.baseG;

  // --- 1. redundant pieces -------------------------------------------------
  const seen = new Map<string, Row>();
  for (const r of rows) {
    if (!inBase(r)) continue;
    const key = normalizeText(`${r.e.item.brand ?? ''} ${r.e.item.name}`);
    const first = seen.get(key);
    if (first && first.e.item.id !== r.e.item.id && !r.locked && !isProtectedRole(r.role) && !MULTI_OK.has(r.e.item.categoryKey)) {
      const saved = r.e.item.weightG * r.e.entry.quantity;
      removed.add(r.idx);
      runningBase -= saved;
      steps.push({
        kind: 'remove',
        itemId: r.e.item.id,
        itemName: r.e.item.name,
        savedG: saved,
        reason: `Duplicitní položka „${r.e.item.name}“ – stačí jedna (úspora ${fmtG(saved)}).`,
        estimated: isEstimatedItem(r.e.item),
      });
      continue;
    }
    if (!first) seen.set(key, r);
    const q = r.e.entry.quantity;
    if (q > 1 && !r.locked && !isProtectedRole(r.role) && !MULTI_OK.has(r.e.item.categoryKey) && r.e.item.weightG > 0) {
      const saved = r.e.item.weightG * (q - 1);
      qtyOverride.set(r.idx, 1);
      runningBase -= saved;
      steps.push({
        kind: 'reduce_quantity',
        itemId: r.e.item.id,
        itemName: r.e.item.name,
        savedG: saved,
        reason: `Počet ${q} ks → 1 ks u „${r.e.item.name}“ (úspora ${fmtG(saved)}).`,
        comfortTradeoff: 'Žádná záloha téhle položky.',
        estimated: isEstimatedItem(r.e.item),
      });
    }
  }

  // --- 2. optional items ---------------------------------------------------
  const optionalRows = rows
    .filter((r) => r.e.entry.carryMode === 'optional' && !removed.has(r.idx))
    .sort((a, b) => b.e.item.weightG * b.e.entry.quantity - a.e.item.weightG * a.e.entry.quantity || a.e.item.name.localeCompare(b.e.item.name, 'cs'));
  for (const r of optionalRows) {
    const saved = r.e.item.weightG * (qtyOverride.has(r.idx) ? 1 : r.e.entry.quantity);
    if (r.locked || isProtectedRole(r.role)) {
      blocked.push({
        itemName: r.e.item.name,
        reason: r.locked ? 'Položka je označena jako nezbytná nebo povinná – nelze vynechat.' : `Bezpečnostní výbava (${GEAR_ROLE_LABELS_CS[r.role!]}) se nevynechává.`,
      });
      continue;
    }
    const needMore = runningBase > input.targetBaseWeightG;
    if (input.comfort === 'minimal' || needMore) {
      removed.add(r.idx);
      runningBase -= saved;
      steps.push({
        kind: 'remove',
        itemId: r.e.item.id,
        itemName: r.e.item.name,
        savedG: saved,
        reason: `Volitelná položka „${r.e.item.name}“ – vynecháním ušetříte ${fmtG(saved)}.`,
        comfortTradeoff: 'Menší komfort nebo nižší rezerva.',
        estimated: isEstimatedItem(r.e.item),
      });
    } else {
      steps.push({
        kind: 'keep',
        itemId: r.e.item.id,
        itemName: r.e.item.name,
        savedG: 0,
        reason: `Cíl už je splněn, volitelná položka „${r.e.item.name}“ zůstává pro komfort.`,
        estimated: isEstimatedItem(r.e.item),
      });
    }
  }

  // --- 3. replacements -------------------------------------------------------
  interface Pending {
    row: Row;
    cand: OptimizerCandidate;
    savedG: number;
    cost: number;
    safetyNote?: string;
  }
  const groups: Pending[][] = [];
  const candidates = input.candidates ?? [];
  const byId = new Map(rows.map((r) => [r.e.item.id, r]));
  const perRow = new Map<number, Pending[]>();

  for (const cand of candidates) {
    let target: Row | undefined;
    if (cand.replacesItemId) target = byId.get(cand.replacesItemId);
    else {
      target = rows
        .filter((r) => inBase(r) && r.e.item.categoryKey === cand.categoryKey && !removed.has(r.idx) && !r.locked && r.e.item.weightG > cand.weightG)
        .sort((a, b) => b.e.item.weightG - a.e.item.weightG || a.idx - b.idx)[0];
    }
    if (!target || removed.has(target.idx) || !inBase(target)) continue;
    const item = target.e.item;
    const qty = qtyOverride.get(target.idx) ?? target.e.entry.quantity;
    if (target.locked) {
      blocked.push({ itemName: item.name, reason: `Náhrada „${cand.name}“ zamítnuta: položka je nezbytná nebo povinná.` });
      continue;
    }
    if (input.budget && cand.price !== undefined && cand.source !== 'inventory' && (cand.currency ?? input.budget.currency) !== input.budget.currency) {
      advisories.push(
        adv('optimizer_currency_mismatch', 'warning', `Kandidát „${cand.name}“ má cenu v jiné měně (${cand.currency}) než rozpočet (${input.budget.currency}) – přeskočeno.`, {
          params: { candidate: cand.name },
        }),
      );
      continue;
    }
    const savedG = (item.weightG - cand.weightG) * qty;
    if (savedG <= 0) continue;

    // safety checks
    const role = target.role;
    let safetyNote: string | undefined;
    let reject: string | undefined;
    if (role === 'sleep_bag') {
      if (dayTrip) safetyNote = undefined;
      else if (minTemp !== undefined) {
        if (cand.comfortTempC === undefined) reject = 'Náhradní spacák/quilt nemá uvedenou komfortní teplotu.';
        else if (cand.comfortTempC > minTemp + 3) reject = `Komfortní teplota ${cand.comfortTempC} °C je vyšší než nejnižší očekávaná ${minTemp} °C + 3 °C rezerva.`;
        else safetyNote = `Komfortní teplota ${cand.comfortTempC} °C vyhovuje očekávaným ${minTemp} °C (+3 °C rezerva).`;
      } else if (cand.comfortTempC === undefined || item.comfortTempC === undefined) {
        reject = 'Není zadána očekávaná minimální teplota ani komfortní teplota – nelze bezpečně ověřit.';
      } else if (cand.comfortTempC > item.comfortTempC) {
        reject = `Náhrada je teplotně slabší (${cand.comfortTempC} °C) než současný spacák (${item.comfortTempC} °C).`;
      }
    } else if (role === 'rain_shell') {
      if (input.expected.rain && cand.waterproof !== true) reject = 'Při očekávaném dešti musí nepromokavá vrstva zůstat nepromokavá.';
      else if (cand.waterproof === false) reject = 'Náhrada není nepromokavá.';
      else if (cand.waterproof === undefined) safetyNote = 'Ověřte, že náhrada je skutečně nepromokavá.';
    } else if (role === 'shelter') {
      if (cand.waterproof === false && input.expected.rain) reject = 'Přístřešek při dešti musí být nepromokavý.';
      else if (input.expected.wind) safetyNote = 'Lehčí přístřešek hůře odolává větru – ověřte stabilitu a kotvení.';
    } else if (role === 'sleep_pad') {
      safetyNote = 'Ověřte R-hodnotu karimatky pro očekávanou teplotu.';
    }
    if (!reject && isProtectedRole(role) && cand.categoryKey !== item.categoryKey) reject = 'Náhrada bezpečnostní výbavy musí být ve stejné kategorii.';
    if (!reject && isProtectedRole(role) && !safetyNote) safetyNote = 'Ověřte, že náhrada plní stejnou funkci.';
    if (reject) {
      blocked.push({ itemName: item.name, reason: `Náhrada „${cand.name}“ zamítnuta: ${reject}` });
      continue;
    }
    const cost = cand.source === 'inventory' ? 0 : (cand.price ?? 0) * qty;
    const p: Pending = { row: target, cand, savedG, cost, safetyNote };
    const list = perRow.get(target.idx) ?? [];
    list.push(p);
    perRow.set(target.idx, list);
  }
  for (const idx of [...perRow.keys()].sort((a, b) => a - b)) groups.push(perRow.get(idx)!);

  const gapBefore = runningBase - input.targetBaseWeightG;
  const capacity = input.budget ? Math.max(0, input.budget.amount) : Infinity;
  const options: KnapsackOption[][] = groups.map((g, gi) => g.map((p, pi) => ({ id: `${gi}:${pi}`, value: p.savedG, cost: p.cost })));
  const sol = solveKnapsack(options, capacity);
  let picked: Pending[] = [];
  sol.chosen.forEach((o, gi) => {
    if (o) picked.push(groups[gi]![Number(o.id.split(':')[1])]!);
  });

  // balanced / comfort: do not spend more than needed to reach the target
  if (input.comfort !== 'minimal') {
    if (gapBefore <= 0) picked = [];
    else {
      let total = picked.reduce((s, p) => s + p.savedG, 0);
      const order = [...picked].sort((a, b) => b.cost / b.savedG - a.cost / a.savedG || a.row.idx - b.row.idx);
      for (const p of order) {
        if (input.comfort === 'balanced' && p.cost === 0) continue;
        if (total - p.savedG >= gapBefore) {
          picked = picked.filter((x) => x !== p);
          total -= p.savedG;
        }
      }
    }
  }
  picked.sort((a, b) => a.row.idx - b.row.idx);
  for (const p of picked) {
    replaced.set(p.row.idx, p.cand);
    runningBase -= p.savedG;
    const estimated = p.cand.estimated || isEstimatedItem(p.row.e.item);
    steps.push({
      kind: 'replace',
      itemId: p.row.e.item.id,
      itemName: p.row.e.item.name,
      replacementName: p.cand.name,
      savedG: p.savedG,
      cost: p.cost,
      costPerGramSaved: p.cost > 0 ? p.cost / p.savedG : 0,
      reason: `Výměna „${p.row.e.item.name}“ za „${p.cand.name}“ ušetří ${fmtG(p.savedG)}${p.cost > 0 ? ` za ${Math.round(p.cost)} ${input.budget?.currency ?? p.cand.currency ?? ''}`.trimEnd() : ' (bez nákladů)'}.`,
      comfortTradeoff: p.cand.source === 'reference' ? 'Referenční typ – konkrétní produkt si vyberte a ověřte jeho váhu.' : undefined,
      safetyNote: p.safetyNote,
      estimated,
    });
  }

  // --- result ---------------------------------------------------------------
  const afterEntries: GearEntry[] = [];
  for (const r of rows) {
    if (removed.has(r.idx)) continue;
    const q = qtyOverride.get(r.idx);
    const rep = replaced.get(r.idx);
    const item = rep ? withReplacement(r.e.item, rep) : r.e.item;
    const mode: CarryMode = r.e.entry.carryMode;
    afterEntries.push({ item, entry: { ...r.e.entry, quantity: q ?? r.e.entry.quantity, carryMode: mode } });
  }
  const after = calculatePackWeight(afterEntries);
  const totalSavedG = steps.filter((s) => s.kind !== 'keep').reduce((s, x) => s + x.savedG, 0);
  const totalCost = steps.reduce((s, x) => s + (x.cost ?? 0), 0);
  const gapG = Math.max(0, after.baseG - input.targetBaseWeightG);
  const targetReached = after.baseG <= input.targetBaseWeightG;
  const withinBudget = !input.budget || totalCost <= input.budget.amount + 1e-9;

  // advisories on the resulting loadout
  const rolesAfter = new Set(afterEntries.filter((e) => e.entry.carryMode !== 'consumable').map((e) => gearRole(e.item)));
  if (!rolesAfter.has('first_aid')) advisories.push(adv('optimizer_missing_first_aid', 'warning', 'V seznamu chybí lékárnička.', { action: 'Přidejte lékárničku.' }));
  if (!rolesAfter.has('light') && !dayTrip) advisories.push(adv('optimizer_missing_light', 'warning', 'V seznamu chybí čelovka nebo jiné světlo.', { action: 'Přidejte čelovku s rezervními bateriemi.' }));
  if (input.expected.rain && !rolesAfter.has('rain_shell')) advisories.push(adv('optimizer_missing_rain_shell', 'danger', 'Očekává se déšť, ale v seznamu není nepromokavá vrstva.', { action: 'Přidejte nepromokavou bundu nebo pláštěnku.' }));
  if (!dayTrip && !rolesAfter.has('shelter')) advisories.push(adv('optimizer_missing_shelter', 'warning', 'V seznamu chybí přístřešek (stan, tarp, hamak, bivak).'));
  if (!dayTrip && minTemp !== undefined) {
    for (const e of afterEntries) {
      if (gearRole(e.item) === 'sleep_bag' && e.item.comfortTempC !== undefined && e.item.comfortTempC > minTemp + 3) {
        advisories.push(
          adv('optimizer_sleep_inadequate', 'danger', `Spací systém „${e.item.name}“ (komfort ${e.item.comfortTempC} °C) je slabý pro očekávaných ${minTemp} °C.`, {
            params: { comfortTempC: e.item.comfortTempC, minTempC: minTemp },
            action: 'Zvolte teplejší spacák nebo přidejte izolaci; optimalizátor tuto položku neslehčuje.',
          }),
        );
      }
    }
  }
  if (!targetReached) {
    advisories.push(
      adv('optimizer_target_gap', 'info', `Cíl ${fmtG(input.targetBaseWeightG)} nebyl dosažen, chybí ještě ${fmtG(gapG)} bez zásahu do bezpečnostní výbavy.`, {
        params: { gapG, targetG: input.targetBaseWeightG },
        action: 'Zvažte lehčí „velkou trojku“ (batoh, přístřešek, spací systém) nebo vyšší rozpočet.',
      }),
    );
  }
  if (!withinBudget) advisories.push(adv('optimizer_over_budget', 'warning', 'Náklady překračují rozpočet.', { params: { totalCost } }));
  if (before.unconfirmedCount > 0) {
    advisories.push(
      adv('optimizer_unconfirmed_weights', 'info', `${before.unconfirmedCount} položek má nepotvrzenou váhu – výsledky jsou orientační.`, {
        uncertainty: 'Zvažte položky na váze a potvrďte hmotnost.',
      }),
    );
  }
  if (steps.some((s) => s.estimated && s.kind !== 'keep')) {
    advisories.push(adv('optimizer_estimated_values', 'info', 'Část úspor vychází z odhadovaných hodnot (označeno jako odhad).'));
  }

  return { before, after, steps, totalSavedG, totalCost, withinBudget, targetReached, gapG, blockedBySafety: blocked, advisories };
}

// ---------------------------------------------------------------------------
// Reference table & saving opportunities
// ---------------------------------------------------------------------------

export interface ReferenceRange {
  id: string;
  label: string;
  categoryKeys: readonly string[] | 'any';
  nameKeywords?: readonly string[];
  /** Typical weight range of mainstream products, grams (ESTIMATE). */
  typicalMinG: number;
  typicalMaxG: number;
  /** Upper end of typical ultralight products, grams (ESTIMATE). */
  ulMaxG: number;
  /** Compare the whole entry (quantity × weight) instead of one piece. */
  perEntry?: boolean;
}

/**
 * Orientation ranges only – NOT measured product data. Every range is marked
 * `reference: true, estimated: true` in {@link SavingOpportunity}.
 */
export const REFERENCE_RANGES: readonly ReferenceRange[] = [
  { id: 'pack', label: 'Batoh', categoryKeys: ['packs'], typicalMinG: 1200, typicalMaxG: 2200, ulMaxG: 900 },
  { id: 'tent', label: 'Stan (1–2 os.)', categoryKeys: ['tents'], typicalMinG: 1200, typicalMaxG: 2400, ulMaxG: 1000 },
  { id: 'tarp', label: 'Tarp', categoryKeys: ['tarps'], typicalMinG: 450, typicalMaxG: 900, ulMaxG: 400 },
  { id: 'hammock', label: 'Hamak se závěsem', categoryKeys: ['hammocks'], typicalMinG: 700, typicalMaxG: 1500, ulMaxG: 700 },
  { id: 'sleeping_bag', label: 'Spacák (3 sezóny)', categoryKeys: ['sleeping_bags'], typicalMinG: 900, typicalMaxG: 1600, ulMaxG: 850 },
  { id: 'quilt', label: 'Quilt', categoryKeys: ['quilts'], typicalMinG: 600, typicalMaxG: 1000, ulMaxG: 650 },
  { id: 'pad', label: 'Karimatka', categoryKeys: ['sleeping_pads'], typicalMinG: 450, typicalMaxG: 900, ulMaxG: 450 },
  { id: 'stove', label: 'Vařič', categoryKeys: ['cooking'], nameKeywords: ['varic', 'stove', 'horak', 'burner'], typicalMinG: 80, typicalMaxG: 250, ulMaxG: 100 },
  { id: 'pot', label: 'Hrnec / hrnek', categoryKeys: ['cooking'], nameKeywords: ['hrnec', 'hrnek', 'pot', 'mug', 'kotlik'], typicalMinG: 150, typicalMaxG: 400, ulMaxG: 180 },
  { id: 'filter', label: 'Filtr na vodu', categoryKeys: ['water'], nameKeywords: ['filtr', 'filter'], typicalMinG: 100, typicalMaxG: 350, ulMaxG: 100 },
  { id: 'headlamp', label: 'Čelovka', categoryKeys: ['electronics'], nameKeywords: ['celovk', 'headlamp'], typicalMinG: 80, typicalMaxG: 160, ulMaxG: 80 },
  { id: 'powerbank', label: 'Powerbanka', categoryKeys: ['electronics'], nameKeywords: ['powerbank', 'power bank', 'powerbanka'], typicalMinG: 250, typicalMaxG: 450, ulMaxG: 250 },
  { id: 'rain_jacket', label: 'Nepromokavá bunda', categoryKeys: ['clothing'], nameKeywords: ['plastenk', 'rain', 'shell', 'nepromok', 'goretex', 'gore-tex'], typicalMinG: 250, typicalMaxG: 500, ulMaxG: 250 },
  { id: 'insulation', label: 'Izolační bunda', categoryKeys: ['clothing'], nameKeywords: ['pirov', 'down', 'primaloft', 'puffy', 'izolacni'], typicalMinG: 350, typicalMaxG: 650, ulMaxG: 350 },
  { id: 'poles', label: 'Trekové hole (pár)', categoryKeys: 'any', nameKeywords: ['hole', 'trekking pole', 'poles', 'pole'], typicalMinG: 450, typicalMaxG: 650, ulMaxG: 450, perEntry: true },
];

export interface SavingOpportunity {
  itemId: string;
  itemName: string;
  categoryKey: string;
  referenceId: string;
  referenceLabel: string;
  weightG: number;
  typicalRangeG: [number, number];
  ulMaxG: number;
  /** Grams that could be saved by switching to a typical ultralight product. */
  potentialSavedG: number;
  /** `heavy` = above the typical range, `moderate` = above ultralight range. */
  level: 'moderate' | 'heavy';
  note: string;
  reference: true;
  estimated: true;
}

/**
 * Compare packed items against the orientation reference ranges and list where
 * the biggest savings are likely. Reference values are estimates, not facts.
 */
export function findSavingOpportunities(entries: readonly GearEntry[]): SavingOpportunity[] {
  const out: SavingOpportunity[] = [];
  for (const e of entries) {
    if (e.entry.carryMode === 'worn' || e.entry.carryMode === 'consumable') continue;
    const name = normalizeText(`${e.item.brand ?? ''} ${e.item.name}`);
    const ref = REFERENCE_RANGES.find(
      (r) => (r.categoryKeys === 'any' || r.categoryKeys.includes(e.item.categoryKey)) && (!r.nameKeywords || matchesAnyKeyword(name, r.nameKeywords)),
    );
    if (!ref) continue;
    const weightG = ref.perEntry ? e.item.weightG * e.entry.quantity : e.item.weightG;
    if (weightG <= ref.ulMaxG) continue;
    const level = weightG > ref.typicalMaxG ? 'heavy' : 'moderate';
    out.push({
      itemId: e.item.id,
      itemName: e.item.name,
      categoryKey: e.item.categoryKey,
      referenceId: ref.id,
      referenceLabel: ref.label,
      weightG,
      typicalRangeG: [ref.typicalMinG, ref.typicalMaxG],
      ulMaxG: ref.ulMaxG,
      potentialSavedG: Math.round(weightG - ref.ulMaxG),
      level,
      note:
        level === 'heavy'
          ? `${ref.label}: ${fmtG(weightG)} je nad běžným rozmezím (orientačně ${ref.typicalMinG}–${ref.typicalMaxG} g). Lehká varianta bývá do ~${ref.ulMaxG} g (odhad).`
          : `${ref.label}: ${fmtG(weightG)}; lehké varianty bývají do ~${ref.ulMaxG} g (odhad).`,
      reference: true,
      estimated: true,
    });
  }
  return out.sort((a, b) => b.potentialSavedG - a.potentialSavedG || a.itemName.localeCompare(b.itemName, 'cs'));
}
