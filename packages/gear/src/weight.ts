/**
 * Pack-weight maths. All weights are grams; an entry weighs
 * `item.weightG × entry.quantity` (item.weightG is ONE piece).
 *
 * Conventions (LighterPack / ULA):
 * - base weight  = packed + (optional, when included) – excludes worn and consumables
 * - worn weight  = clothing/gear on the body
 * - consumables  = food, water, fuel
 * - carried      = base + consumables (what hangs on the back)
 * - total (skin-out) = carried + worn
 */
import type { CarryMode, GearItem, LoadoutItem } from '@trailpack/shared';

export interface GearEntry {
  item: GearItem;
  entry: LoadoutItem;
}

export interface PackWeightOptions {
  /** Count `optional` items into base weight (default true). */
  includeOptional?: boolean;
  /** Extra consumable weight not present as loadout entries, grams. */
  consumables?: { foodG?: number; waterG?: number; fuelG?: number };
}

export interface CategoryWeight {
  baseG: number;
  wornG: number;
  consumableG: number;
  count: number;
}

export interface HeaviestItem {
  itemId: string;
  name: string;
  weightG: number;
  /** Share of total (skin-out) weight, 0–1. */
  share: number;
}

export type WeightClass = 'super_ultralight' | 'ultralight' | 'lightweight' | 'traditional';

export interface PackWeight {
  baseG: number;
  wornG: number;
  consumableG: number;
  /** Weight of `optional` items (included in baseG only when includeOptional). */
  optionalG: number;
  carriedG: number;
  totalG: number;
  itemCount: number;
  byCategory: Record<string, CategoryWeight>;
  heaviest: HeaviestItem[];
  /** Entries whose weight was not confirmed by the user. */
  unconfirmedCount: number;
  classification: WeightClass;
}

/** Base-weight class thresholds in grams (exclusive upper bounds). */
export const WEIGHT_CLASS_LIMITS_G = { super_ultralight: 2300, ultralight: 4500, lightweight: 9000 } as const;

export function classifyBaseWeight(baseG: number): WeightClass {
  if (baseG < WEIGHT_CLASS_LIMITS_G.super_ultralight) return 'super_ultralight';
  if (baseG < WEIGHT_CLASS_LIMITS_G.ultralight) return 'ultralight';
  if (baseG < WEIGHT_CLASS_LIMITS_G.lightweight) return 'lightweight';
  return 'traditional';
}

export const WEIGHT_CLASS_LABELS_CS: Record<WeightClass, string> = {
  super_ultralight: 'Super ultralight (< 2,3 kg)',
  ultralight: 'Ultralight (< 4,5 kg)',
  lightweight: 'Lightweight (< 9 kg)',
  traditional: 'Tradiční (≥ 9 kg)',
};

/** Weight of one entry in grams. */
export const entryWeightG = (e: GearEntry): number => e.item.weightG * e.entry.quantity;

function bucket(byCategory: Record<string, CategoryWeight>, key: string): CategoryWeight {
  return (byCategory[key] ??= { baseG: 0, wornG: 0, consumableG: 0, count: 0 });
}

/** Aggregate loadout weights. Pure; does not mutate input. */
export function calculatePackWeight(entries: readonly GearEntry[], opts: PackWeightOptions = {}): PackWeight {
  const includeOptional = opts.includeOptional ?? true;
  let baseG = 0;
  let wornG = 0;
  let consumableG = 0;
  let optionalG = 0;
  let itemCount = 0;
  let unconfirmedCount = 0;
  const byCategory: Record<string, CategoryWeight> = {};
  const weighted: Array<{ itemId: string; name: string; weightG: number }> = [];

  for (const e of entries) {
    const w = entryWeightG(e);
    const mode: CarryMode = e.entry.carryMode;
    const cat = bucket(byCategory, e.item.categoryKey);
    cat.count += e.entry.quantity;
    itemCount += e.entry.quantity;
    if (!e.item.weightConfirmed) unconfirmedCount += 1;
    weighted.push({ itemId: e.item.id, name: e.item.name, weightG: w });
    switch (mode) {
      case 'worn':
        wornG += w;
        cat.wornG += w;
        break;
      case 'consumable':
        consumableG += w;
        cat.consumableG += w;
        break;
      case 'optional':
        optionalG += w;
        if (includeOptional) {
          baseG += w;
          cat.baseG += w;
        }
        break;
      default:
        baseG += w;
        cat.baseG += w;
    }
  }

  const extra = opts.consumables;
  if (extra) {
    const add = (g: number | undefined, key: string): void => {
      if (!g || g <= 0) return;
      consumableG += g;
      bucket(byCategory, key).consumableG += g;
    };
    add(extra.foodG, 'food');
    add(extra.waterG, 'water');
    add(extra.fuelG, 'cooking');
  }

  const carriedG = baseG + consumableG;
  const totalG = carriedG + wornG;
  const heaviest = weighted
    .filter((w) => w.weightG > 0)
    .sort((a, b) => b.weightG - a.weightG || a.name.localeCompare(b.name, 'cs'))
    .slice(0, 10)
    .map((w) => ({ ...w, share: totalG > 0 ? w.weightG / totalG : 0 }));

  return {
    baseG,
    wornG,
    consumableG,
    optionalG,
    carriedG,
    totalG,
    itemCount,
    byCategory,
    heaviest,
    unconfirmedCount,
    classification: classifyBaseWeight(baseG),
  };
}

export interface CategoryDiff {
  categoryKey: string;
  aBaseG: number;
  bBaseG: number;
  /** b − a (negative = b is lighter). */
  diffG: number;
}

export interface ItemDiff {
  itemId: string;
  name: string;
  aWeightG: number;
  bWeightG: number;
  diffG: number;
  aMode?: CarryMode;
  bMode?: CarryMode;
}

export interface LoadoutComparison {
  a: PackWeight;
  b: PackWeight;
  totals: { baseG: number; wornG: number; consumableG: number; carriedG: number; totalG: number };
  byCategory: CategoryDiff[];
  onlyInA: ItemDiff[];
  onlyInB: ItemDiff[];
  changed: ItemDiff[];
}

/** Compare two loadouts; all differences are `b − a`. */
export function compareLoadouts(a: readonly GearEntry[], b: readonly GearEntry[], opts: PackWeightOptions = {}): LoadoutComparison {
  const wa = calculatePackWeight(a, opts);
  const wb = calculatePackWeight(b, opts);
  const keys = [...new Set([...Object.keys(wa.byCategory), ...Object.keys(wb.byCategory)])].sort();
  const byCategory = keys
    .map((k) => {
      const aBaseG = wa.byCategory[k]?.baseG ?? 0;
      const bBaseG = wb.byCategory[k]?.baseG ?? 0;
      return { categoryKey: k, aBaseG, bBaseG, diffG: bBaseG - aBaseG };
    })
    .filter((c) => c.aBaseG !== 0 || c.bBaseG !== 0);

  const index = (xs: readonly GearEntry[]): Map<string, { w: number; mode: CarryMode; name: string }> => {
    const m = new Map<string, { w: number; mode: CarryMode; name: string }>();
    for (const e of xs) {
      const prev = m.get(e.item.id);
      m.set(e.item.id, { w: (prev?.w ?? 0) + entryWeightG(e), mode: e.entry.carryMode, name: e.item.name });
    }
    return m;
  };
  const ia = index(a);
  const ib = index(b);
  const onlyInA: ItemDiff[] = [];
  const onlyInB: ItemDiff[] = [];
  const changed: ItemDiff[] = [];
  for (const [id, x] of ia) {
    const y = ib.get(id);
    if (!y) onlyInA.push({ itemId: id, name: x.name, aWeightG: x.w, bWeightG: 0, diffG: -x.w, aMode: x.mode });
    else if (y.w !== x.w || y.mode !== x.mode) {
      changed.push({ itemId: id, name: x.name, aWeightG: x.w, bWeightG: y.w, diffG: y.w - x.w, aMode: x.mode, bMode: y.mode });
    }
  }
  for (const [id, y] of ib) {
    if (!ia.has(id)) onlyInB.push({ itemId: id, name: y.name, aWeightG: 0, bWeightG: y.w, diffG: y.w, bMode: y.mode });
  }
  const sortDiff = (xs: ItemDiff[]): ItemDiff[] => xs.sort((p, q) => Math.abs(q.diffG) - Math.abs(p.diffG) || p.name.localeCompare(q.name, 'cs'));
  return {
    a: wa,
    b: wb,
    totals: {
      baseG: wb.baseG - wa.baseG,
      wornG: wb.wornG - wa.wornG,
      consumableG: wb.consumableG - wa.consumableG,
      carriedG: wb.carriedG - wa.carriedG,
      totalG: wb.totalG - wa.totalG,
    },
    byCategory,
    onlyInA: sortDiff(onlyInA),
    onlyInB: sortDiff(onlyInB),
    changed: sortDiff(changed),
  };
}
