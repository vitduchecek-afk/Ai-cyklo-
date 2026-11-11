/**
 * Pack-zone recommendations, weight distribution, volume estimates and packing progress.
 */
import type { CarryMode, GearItem, LoadoutItem, PackLocation } from '@trailpack/shared';
import type { GearEntry } from './weight';
import { GEAR_ROLE_LABELS_CS, gearRole, type GearRole } from './roles';
import { matchesAnyKeyword, normalizeText } from './text';

export interface PackLocationAdvice {
  location: PackLocation;
  /** Czech reason. */
  reason: string;
  /** True when the item should go into a waterproof bag / dry sack. */
  waterproofBag: boolean;
}

const has = (name: string, kws: readonly string[]): boolean => matchesAnyKeyword(name, kws);

/** Recommend where in/on the pack an item belongs (ignores any manual `packLocation`). */
export function recommendPackLocation(item: GearItem, entry: LoadoutItem): PackLocationAdvice {
  const name = normalizeText(`${item.name} ${entry.notes ?? ''}`);
  const mk = (location: PackLocation, reason: string, waterproofBag = false): PackLocationAdvice => ({ location, reason, waterproofBag });
  const mode: CarryMode = entry.carryMode;
  const unitG = item.weightG;
  const role = gearRole(item);

  if (mode === 'worn') return mk('worn', 'Nosí se na těle – nezatěžuje batoh.');
  if (role === 'first_aid') return mk('lid', 'Lékárnička musí být rychle dostupná i v nouzi.');
  if (role === 'emergency' || has(name, ['nouzov', 'piskalk', 'whistle', 'folie'])) return mk('lid', 'Nouzová výbava musí být po ruce bez vybalování batohu.');
  if (role === 'light') return mk('lid', 'Čelovka patří do víka nebo horní kapsy – je potřeba rychle, často za tmy.');
  if (role === 'rain_shell') return mk('lid', 'Nepromokavá vrstva musí jít vytáhnout bez vybalování batohu při první dešťové přeháňce.');
  if (role === 'navigation') return mk('hip_belt', 'Mapa/navigace na bederním pásu nebo v kapse – kontrola bez zastavení.');
  if (role === 'water_treatment') return mk('side_pocket', 'Filtr v boční kapse – doplňování vody bez rozebírání batohu.');
  if (has(name, ['snack', 'svacin', 'tycink', 'bar', 'gel', 'sušen', 'susen', 'orisk', 'ořech'])) return mk('hip_belt', 'Svačiny na bederním pásu – jídlo za chůze bez zastavení.');
  if (has(name, ['opalov', 'sunscreen', 'bryle', 'sunglass', 'sluneční', 'slunecni', 'repelent', 'kapesnik'])) return mk('lid', 'Ochrana před sluncem a hmyzem se používá často – víko batohu.');
  if (item.categoryKey === 'electronics') return mk('middle_front', 'Elektronika do vodotěsného sáčku uprostřed batohu, chráněná před deštěm a nárazy.', true);
  if (item.categoryKey === 'water') {
    if (has(name, ['lahev', 'bottle', 'flask', 'flasa'])) return mk('side_pocket', 'Láhev v boční kapse – pití bez sundávání batohu.');
    return mk('middle_back', 'Voda je těžká – blízko zad a středu těžiště.');
  }
  if (item.categoryKey === 'sleeping_bags' || item.categoryKey === 'quilts') return mk('bottom', 'Spacák dole – lehký, stlačitelný, využívá se až v táboře; stabilní základ batohu.', true);
  if (item.categoryKey === 'sleeping_pads') return mk('outside', 'Karimatka zvenku nebo po obvodu – chrání obsah a šetří objem.');
  if (item.categoryKey === 'tarps' || (item.categoryKey === 'tents' && has(name, ['mokr', 'wet']))) return mk('front_pocket', 'Mokrý stan/tarp do vnější přední kapsy, aby nenavlhl ostatní věci.');
  if (item.categoryKey === 'tents') return mk('middle_front', 'Stan je těžký, ale objemný – střed batohu, tyče blíž k zádům.');
  if (item.categoryKey === 'hammocks') return mk('top', 'Hamak je lehký a stlačitelný – horní část.');
  if (item.categoryKey === 'food' || mode === 'consumable') return mk('middle_back', 'Jídlo je husté a těžké – těsně u zad ve výšce lopatek.');
  if (item.categoryKey === 'cooking') {
    if (has(name, ['kartus', 'canister', 'palivo', 'fuel'])) return mk('middle_front', 'Palivo mimo jídlo, ve středu batohu, upevněné proti pohybu.');
    return unitG >= 400 ? mk('middle_back', 'Těžší vařicí sada blízko zad.') : mk('middle_front', 'Vařicí sada uprostřed, odděleně od jídla.');
  }
  if (item.categoryKey === 'footwear') return mk('outside', 'Náhradní/táborová obuv zvenku – nešpiní obsah batohu.');
  if (item.categoryKey === 'clothing') {
    if (role === 'insulation') return mk('top', 'Izolační vrstva nahoře – rychle po ruce při zastávce.');
    return unitG >= 500 ? mk('bottom', 'Objemnější oblečení do spodní části.') : mk('top', 'Lehké oblečení v horní části.');
  }
  if (item.categoryKey === 'hygiene' || item.categoryKey === 'repair') return mk('middle_front', 'Drobnosti uprostřed batohu, v samostatném sáčku.');
  if (item.categoryKey === 'packs') return mk('outside', 'Samotný batoh (např. sáček/brašna) – nosí se zvenku.');
  if (unitG >= 600) return mk('middle_back', 'Těžká a hustá věc blízko zad a středu těžiště.');
  if (unitG >= 150) return mk('middle_front', 'Středně těžká věc uprostřed batohu.');
  return mk('top', 'Lehká věc nahoře.');
}

/** Typical packed volume per piece in litres by category (ESTIMATES). */
export const TYPICAL_VOLUME_L: Record<string, number> = {
  packs: 0,
  tents: 3,
  tarps: 1.5,
  hammocks: 1.5,
  sleeping_bags: 8,
  quilts: 6,
  sleeping_pads: 3,
  clothing: 1.5,
  footwear: 3,
  cooking: 1,
  water: 0.8,
  electronics: 0.3,
  hygiene: 0.3,
  first_aid: 0.5,
  repair: 0.2,
  food: 1,
  other: 0.5,
};

export interface VolumeEstimate {
  /** Litres for ONE piece. */
  volumeL: number;
  estimated: boolean;
}

/**
 * Packed volume of one piece, litres. User value → exact; dimensions → bounding box
 * (exact flag, but an upper bound); otherwise category typical (`estimated: true`).
 */
export function estimateVolumeL(item: GearItem): VolumeEstimate {
  if (item.volumeL !== undefined) return { volumeL: item.volumeL, estimated: item.volumeEstimated };
  const d = item.dimensionsCm;
  if (d && d.l > 0 && d.w > 0 && d.h > 0) return { volumeL: (d.l * d.w * d.h) / 1000, estimated: false };
  return { volumeL: TYPICAL_VOLUME_L[item.categoryKey] ?? 0.5, estimated: true };
}

export interface ZoneItem {
  itemId: string;
  name: string;
  quantity: number;
  weightG: number;
  reason: string;
  /** True when the location was set manually by the user. */
  manual: boolean;
}

export interface WeightDistribution {
  bottomG: number;
  middleBackG: number;
  middleFrontG: number;
  /** top + lid */
  topG: number;
  /** side/front pockets, hip belt, shoulder strap, outside */
  pocketsG: number;
  wornG: number;
}

export interface MissingEssential {
  role: GearRole;
  label: string;
}

export interface PackingPlan {
  zones: Partial<Record<PackLocation, ZoneItem[]>>;
  weightDistribution: WeightDistribution;
  /** 0–100, higher = better balanced. */
  balanceScore: number;
  /** Czech explanation. */
  explanation: string;
  volume: {
    usedL: number;
    packVolumeL?: number;
    /** Percent of pack volume used (undefined without pack volume). */
    fillPct?: number;
    estimated: boolean;
    items: Array<{ itemId: string; name: string; volumeL: number; estimated: boolean }>;
  };
  missingEssentials: MissingEssential[];
}

export interface PackingPlanOptions {
  /** Day trip: shelter and sleep system are not required. */
  dayTrip?: boolean;
}

/** Ideal share of carried weight per zone. */
const IDEAL_SHARE = { middleBack: 0.4, middleFront: 0.2, bottom: 0.18, top: 0.12, pockets: 0.1 } as const;

/** Missing safety essentials of a loadout (roles from {@link gearRole}). */
export function findMissingEssentials(entries: readonly GearEntry[], opts: PackingPlanOptions = {}): MissingEssential[] {
  const present = new Set(entries.map((e) => gearRole(e.item)));
  const required: GearRole[] = ['first_aid', 'light', 'navigation', 'rain_shell'];
  if (!opts.dayTrip) required.push('shelter', 'sleep_bag', 'sleep_pad', 'water_treatment');
  return required.filter((r) => !present.has(r)).map((role) => ({ role, label: GEAR_ROLE_LABELS_CS[role] }));
}

const POCKETS: readonly PackLocation[] = ['side_pocket', 'front_pocket', 'hip_belt', 'shoulder_strap', 'outside'];

/** Build the packing plan: zones, weight distribution, balance and volume. */
export function packingPlan(entries: readonly GearEntry[], packVolumeL?: number, opts: PackingPlanOptions = {}): PackingPlan {
  const zones: Partial<Record<PackLocation, ZoneItem[]>> = {};
  const dist: WeightDistribution = { bottomG: 0, middleBackG: 0, middleFrontG: 0, topG: 0, pocketsG: 0, wornG: 0 };
  const volItems: PackingPlan['volume']['items'] = [];
  let usedL = 0;
  let volEstimated = false;

  for (const e of entries) {
    const rec = recommendPackLocation(e.item, e.entry);
    const manual = e.entry.packLocation !== undefined && e.entry.carryMode !== 'worn';
    const location: PackLocation = e.entry.carryMode === 'worn' ? 'worn' : (e.entry.packLocation ?? rec.location);
    const w = e.item.weightG * e.entry.quantity;
    (zones[location] ??= []).push({
      itemId: e.item.id,
      name: e.item.name,
      quantity: e.entry.quantity,
      weightG: w,
      reason: manual ? 'Umístění zvolil uživatel.' : rec.reason,
      manual,
    });
    if (location === 'worn') dist.wornG += w;
    else if (location === 'bottom') dist.bottomG += w;
    else if (location === 'middle_back') dist.middleBackG += w;
    else if (location === 'middle_front') dist.middleFrontG += w;
    else if (location === 'top' || location === 'lid') dist.topG += w;
    else if (POCKETS.includes(location)) dist.pocketsG += w;

    if (location !== 'worn') {
      const v = estimateVolumeL(e.item);
      const total = v.volumeL * e.entry.quantity;
      usedL += total;
      if (v.estimated) volEstimated = true;
      volItems.push({ itemId: e.item.id, name: e.item.name, volumeL: total, estimated: v.estimated });
    }
  }
  for (const list of Object.values(zones)) list?.sort((a, b) => b.weightG - a.weightG || a.name.localeCompare(b.name, 'cs'));

  const carried = dist.bottomG + dist.middleBackG + dist.middleFrontG + dist.topG + dist.pocketsG;
  let balanceScore = 0;
  let explanation = 'Batoh je prázdný – není co vyvažovat.';
  if (carried > 0) {
    const share = {
      middleBack: dist.middleBackG / carried,
      middleFront: dist.middleFrontG / carried,
      bottom: dist.bottomG / carried,
      top: dist.topG / carried,
      pockets: dist.pocketsG / carried,
    };
    const deviations = (Object.keys(IDEAL_SHARE) as Array<keyof typeof IDEAL_SHARE>).map((k) => ({ k, d: share[k] - IDEAL_SHARE[k] }));
    const total = deviations.reduce((s, x) => s + Math.abs(x.d), 0);
    balanceScore = Math.max(0, Math.min(100, Math.round(100 * (1 - total / 1.2))));
    const worst = [...deviations].sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0]!;
    const zoneCs: Record<keyof typeof IDEAL_SHARE, string> = { middleBack: 'středu u zad', middleFront: 'středu vpředu', bottom: 'spodku', top: 'horní části a víku', pockets: 'kapsách a vnějšku' };
    const pct = (x: number): number => Math.round(x * 100);
    if (balanceScore >= 80) explanation = `Rozložení hmotnosti je dobré (${pct(share.middleBack)} % těžiště uprostřed u zad).`;
    else
      explanation = `Nejvíc se liší podíl ${zoneCs[worst.k]}: ${pct(share[worst.k])} % místo orientačních ${pct(IDEAL_SHARE[worst.k])} %. ${
        worst.d > 0 ? 'Přesuňte část těžších věcí blíž k zádům a doprostřed.' : 'Přesuňte sem více hustých, těžkých věcí (jídlo, voda).'
      }`;
  }

  const fillPct = packVolumeL && packVolumeL > 0 ? Math.round((usedL / packVolumeL) * 100) : undefined;
  return {
    zones,
    weightDistribution: dist,
    balanceScore,
    explanation,
    volume: { usedL: Math.round(usedL * 10) / 10, packVolumeL, fillPct, estimated: volEstimated, items: volItems.sort((a, b) => b.volumeL - a.volumeL) },
    missingEssentials: findMissingEssentials(entries, opts),
  };
}

export interface PackingProgress {
  packed: number;
  total: number;
  /** Percent of items packed, 0–100. */
  pct: number;
  packedWeightG: number;
  totalWeightG: number;
  pctWeight: number;
  remaining: Array<{ itemId: string; name: string }>;
}

/** Packing progress; worn items are excluded (they are put on, not packed). */
export function packingProgress(entries: readonly GearEntry[]): PackingProgress {
  const rel = entries.filter((e) => e.entry.carryMode !== 'worn');
  const done = rel.filter((e) => e.entry.packed);
  const w = (xs: readonly GearEntry[]): number => xs.reduce((s, e) => s + e.item.weightG * e.entry.quantity, 0);
  const totalWeightG = w(rel);
  const packedWeightG = w(done);
  return {
    packed: done.length,
    total: rel.length,
    pct: rel.length ? Math.round((done.length / rel.length) * 100) : 100,
    packedWeightG,
    totalWeightG,
    pctWeight: totalWeightG > 0 ? Math.round((packedWeightG / totalWeightG) * 100) : 100,
    remaining: rel.filter((e) => !e.entry.packed).map((e) => ({ itemId: e.item.id, name: e.item.name })),
  };
}
