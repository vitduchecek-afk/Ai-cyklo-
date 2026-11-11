/**
 * Loadout templates: slots without any weights. Weights always come from the
 * user's inventory (see {@link matchTemplateToInventory}).
 */
import type { ActivityType, CarryMode, GearCategoryKey, GearItem } from '@trailpack/shared';
import { normalizeText, tokens } from './text';

export type TemplateKey = 'weekend_bivouac' | 'summer_trek' | 'winter_hike' | 'ultralight' | 'camping' | 'bikepacking' | 'day_hike';

export interface TemplateSlot {
  /** Czech name; also used to match inventory items. */
  name: string;
  categoryKey: GearCategoryKey;
  carryMode: CarryMode;
  /** Safety-critical or trip-defining slot. */
  essential: boolean;
  quantity: number;
  note: string;
}

export interface LoadoutTemplate {
  key: TemplateKey;
  name: string;
  description: string;
  activityType: ActivityType;
  season: 'spring' | 'summer' | 'autumn' | 'winter' | 'all';
  slots: TemplateSlot[];
}

const s = (name: string, categoryKey: GearCategoryKey, carryMode: CarryMode, essential: boolean, quantity: number, note: string): TemplateSlot => ({
  name,
  categoryKey,
  carryMode,
  essential,
  quantity,
  note,
});

/** Safety core shared by all multi-hour trips. */
const safety = (): TemplateSlot[] => [
  s('Lékárnička', 'first_aid', 'packed', true, 1, 'Náplasti, obvaz, léky osobní potřeby, fólie NRC.'),
  s('Čelovka', 'electronics', 'packed', true, 1, 'Plus rezervní baterie.'),
  s('Mapa nebo záložní navigace', 'other', 'packed', true, 1, 'Papírová mapa nebo offline mapy a kompas.'),
  s('Nouzová píšťalka', 'other', 'packed', true, 1, 'Tři signály za minutu = nouzové volání.'),
  s('Telefon', 'electronics', 'packed', true, 1, 'Nabitý, s offline mapami.'),
  s('Opalovací krém', 'hygiene', 'packed', false, 1, 'Ochrana před sluncem.'),
];

const camp = (): TemplateSlot[] => [
  s('Batoh', 'packs', 'packed', true, 1, 'Dimenzujte podle objemu výbavy.'),
  s('Spacák', 'sleeping_bags', 'packed', true, 1, 'Komfortní teplota alespoň o 3 °C pod očekávaným minimem.'),
  s('Karimatka', 'sleeping_pads', 'packed', true, 1, 'R-hodnota dle teploty.'),
  s('Voda láhev', 'water', 'packed', true, 2, 'Kapacita dle zdrojů vody na trase.'),
  s('Filtr na vodu', 'water', 'packed', true, 1, 'Nebo tablety na úpravu vody.'),
  s('Vařič', 'cooking', 'packed', false, 1, 'Podle jídelníčku.'),
  s('Hrnec', 'cooking', 'packed', false, 1, ''),
  s('Lžíce', 'cooking', 'packed', false, 1, ''),
  s('Zapalovač', 'cooking', 'packed', false, 1, 'Plus záložní zapalování.'),
  s('Powerbanka', 'electronics', 'packed', false, 1, 'Dle plánu napájení.'),
  s('Kabel k nabíjení', 'electronics', 'packed', false, 1, ''),
  s('Toaletní papír a lopatka', 'hygiene', 'packed', false, 1, 'Zakopejte min. 15 cm hluboko, 60 m od vody.'),
  s('Kartáček a pasta', 'hygiene', 'packed', false, 1, ''),
  s('Oprava páska', 'repair', 'packed', false, 1, 'Páska, jehla a nit, náhradní kolíky.'),
];

const clothesWarm = (): TemplateSlot[] => [
  s('Nepromokavá bunda', 'clothing', 'packed', true, 1, 'Musí být skutečně nepromokavá.'),
  s('Izolační bunda', 'clothing', 'packed', false, 1, 'Péřová nebo syntetická, na zastávky a noc.'),
  s('Tričko', 'clothing', 'worn', false, 1, ''),
  s('Kalhoty', 'clothing', 'worn', false, 1, ''),
  s('Ponožky', 'clothing', 'worn', false, 2, 'Jeden pár na spaní.'),
  s('Spodní prádlo', 'clothing', 'packed', false, 1, ''),
  s('Čepice', 'clothing', 'packed', false, 1, ''),
  s('Rukavice', 'clothing', 'packed', false, 1, ''),
  s('Turistická obuv', 'footwear', 'worn', true, 1, 'Rozchozená.'),
];

export const LOADOUT_TEMPLATES: Record<TemplateKey, LoadoutTemplate> = {
  weekend_bivouac: {
    key: 'weekend_bivouac',
    name: 'Víkendový bivak',
    description: 'Jedna až dvě noci pod tarpem nebo ve stanu, jednoduché vaření.',
    activityType: 'bivouac',
    season: 'all',
    slots: [
      ...camp(),
      s('Stan nebo tarp', 'tents', 'packed', true, 1, 'Přístřešek odpovídající počasí.'),
      s('Kolíky a šňůry', 'tents', 'packed', false, 1, ''),
      ...clothesWarm(),
      ...safety(),
      s('Jídlo na víkend', 'food', 'consumable', true, 1, 'Včetně rezervy na jeden den.'),
    ],
  },
  summer_trek: {
    key: 'summer_trek',
    name: 'Letní trek',
    description: 'Vícedenní trek v teplém počasí s lehčí výbavou.',
    activityType: 'trekking',
    season: 'summer',
    slots: [
      ...camp(),
      s('Stan', 'tents', 'packed', true, 1, ''),
      s('Nepromokavá bunda', 'clothing', 'packed', true, 1, 'Letní bouřky.'),
      s('Tričko', 'clothing', 'worn', false, 1, ''),
      s('Tričko náhradní', 'clothing', 'packed', false, 1, ''),
      s('Šortky', 'clothing', 'worn', false, 1, ''),
      s('Ponožky', 'clothing', 'worn', false, 2, ''),
      s('Čepice se štítkem', 'clothing', 'packed', false, 1, ''),
      s('Lehká izolační vrstva', 'clothing', 'packed', false, 1, 'Noci v horách bývají chladné.'),
      s('Trail runners', 'footwear', 'worn', true, 1, ''),
      s('Sluneční brýle', 'other', 'packed', false, 1, ''),
      s('Repelent', 'hygiene', 'packed', false, 1, ''),
      ...safety(),
      s('Jídlo', 'food', 'consumable', true, 1, ''),
    ],
  },
  winter_hike: {
    key: 'winter_hike',
    name: 'Zimní výlet',
    description: 'Zimní túra s důrazem na teplo, suché vrstvy a bezpečnost.',
    activityType: 'hiking',
    season: 'winter',
    slots: [
      s('Batoh', 'packs', 'packed', true, 1, ''),
      s('Zimní spacák', 'sleeping_bags', 'packed', false, 1, 'Pouze při nocování; komfort pod očekávanou teplotou.'),
      s('Karimatka', 'sleeping_pads', 'packed', false, 1, 'R-hodnota ≥ 4 pro zimu.'),
      s('Nepromokavá bunda', 'clothing', 'packed', true, 1, ''),
      s('Péřová bunda', 'clothing', 'packed', true, 1, 'Zimní izolace.'),
      s('Termo spodní prádlo', 'clothing', 'worn', true, 1, ''),
      s('Zimní kalhoty', 'clothing', 'worn', false, 1, ''),
      s('Zimní čepice', 'clothing', 'packed', true, 1, ''),
      s('Rukavice', 'clothing', 'packed', true, 2, 'Náhradní pár.'),
      s('Ponožky vlněné', 'clothing', 'worn', false, 2, ''),
      s('Zimní obuv', 'footwear', 'worn', true, 1, ''),
      s('Návleky', 'footwear', 'packed', false, 1, ''),
      s('Mačky', 'other', 'packed', false, 1, 'Dle podmínek na trase.'),
      s('Hole', 'other', 'packed', false, 2, ''),
      s('Termoska', 'water', 'packed', true, 1, 'Horké pití; voda v lahvi mrzne.'),
      s('Vařič', 'cooking', 'packed', false, 1, 'Zimní plyn nebo benzín.'),
      s('Lavinový set', 'other', 'packed', false, 1, 'Lavinové terény: sonda, lopatka, vyhledávač.'),
      s('Brýle', 'other', 'packed', false, 1, 'Ochrana před sněhem a sluncem.'),
      s('Termofolie', 'other', 'packed', true, 1, 'Nouzové zábalení.'),
      s('Powerbanka', 'electronics', 'packed', false, 1, 'V zimě drží kapacitu hůř.'),
      ...safety(),
      s('Jídlo', 'food', 'consumable', true, 1, 'Energeticky bohaté svačiny.'),
    ],
  },
  ultralight: {
    key: 'ultralight',
    name: 'Ultralight',
    description: 'Minimalistická výbava s malým počtem multifunkčních věcí.',
    activityType: 'ultralight',
    season: 'all',
    slots: [
      s('Lehký batoh', 'packs', 'packed', true, 1, ''),
      s('Tarp nebo lehký stan', 'tarps', 'packed', true, 1, ''),
      s('Quilt', 'quilts', 'packed', true, 1, 'Komfortní teplota dle plánu.'),
      s('Lehká karimatka', 'sleeping_pads', 'packed', true, 1, ''),
      s('Větrovka', 'clothing', 'packed', false, 1, ''),
      s('Nepromokavá bunda', 'clothing', 'packed', true, 1, 'Ultralehká, ale nepromokavá.'),
      s('Izolační vrstva', 'clothing', 'packed', false, 1, ''),
      s('Čepice', 'clothing', 'packed', false, 1, ''),
      s('Trail runners', 'footwear', 'worn', true, 1, ''),
      s('Filtr na vodu', 'water', 'packed', true, 1, 'Squeeze filtr nebo tablety.'),
      s('Láhev', 'water', 'packed', true, 2, 'Lehké PET láhve.'),
      s('Lehký vařič', 'cooking', 'packed', false, 1, 'Případně bez vaření (cold soak).'),
      s('Hrnek', 'cooking', 'packed', false, 1, ''),
      s('Lžíce', 'cooking', 'packed', false, 1, ''),
      s('Čelovka', 'electronics', 'packed', true, 1, ''),
      s('Telefon', 'electronics', 'packed', true, 1, ''),
      s('Powerbanka', 'electronics', 'packed', false, 1, ''),
      s('Lékárnička', 'first_aid', 'packed', true, 1, 'Minimalistická, ale kompletní.'),
      s('Mapa nebo záložní navigace', 'other', 'packed', true, 1, ''),
      s('Nouzová píšťalka', 'other', 'packed', true, 1, ''),
      s('Oprava páska', 'repair', 'packed', false, 1, ''),
      s('Hygiena minimum', 'hygiene', 'packed', false, 1, ''),
      s('Jídlo', 'food', 'consumable', true, 1, ''),
    ],
  },
  camping: {
    key: 'camping',
    name: 'Kempování',
    description: 'Pohodový pobyt v kempu nebo u auta, výbava může být těžší.',
    activityType: 'camping',
    season: 'summer',
    slots: [
      s('Stan', 'tents', 'packed', true, 1, ''),
      s('Spacák', 'sleeping_bags', 'packed', true, 1, ''),
      s('Karimatka nebo matrace', 'sleeping_pads', 'packed', true, 1, ''),
      s('Polštářek', 'other', 'packed', false, 1, ''),
      s('Kempingová židle', 'other', 'packed', false, 1, ''),
      s('Stůl', 'other', 'packed', false, 1, ''),
      s('Vařič', 'cooking', 'packed', true, 1, ''),
      s('Kartuše', 'cooking', 'packed', false, 1, ''),
      s('Hrnec', 'cooking', 'packed', false, 1, ''),
      s('Pánev', 'cooking', 'packed', false, 1, ''),
      s('Nádobí', 'cooking', 'packed', false, 2, ''),
      s('Chladicí box', 'food', 'packed', false, 1, ''),
      s('Kanystr na vodu', 'water', 'packed', false, 1, ''),
      s('Svítilna', 'electronics', 'packed', true, 1, ''),
      s('Nabíječka', 'electronics', 'packed', false, 1, ''),
      s('Ručník', 'hygiene', 'packed', false, 1, ''),
      s('Hygienické potřeby', 'hygiene', 'packed', false, 1, ''),
      s('Lékárnička', 'first_aid', 'packed', true, 1, ''),
      s('Nepromokavá bunda', 'clothing', 'packed', true, 1, ''),
      s('Mikina', 'clothing', 'packed', false, 1, ''),
      s('Oprava páska', 'repair', 'packed', false, 1, ''),
      s('Jídlo', 'food', 'consumable', true, 1, ''),
    ],
  },
  bikepacking: {
    key: 'bikepacking',
    name: 'Bikepacking',
    description: 'Vícedenní jízda na kole se zavazadly na rámu, řídítkách a sedlu.',
    activityType: 'bikepacking',
    season: 'all',
    slots: [
      s('Brašna na řídítka', 'packs', 'packed', true, 1, 'Na spací systém.'),
      s('Brašna pod sedlo', 'packs', 'packed', true, 1, 'Na oblečení.'),
      s('Brašna na rám', 'packs', 'packed', false, 1, 'Těžší věci, nízko.'),
      s('Stan nebo bivak', 'tents', 'packed', true, 1, ''),
      s('Spacák nebo quilt', 'sleeping_bags', 'packed', true, 1, ''),
      s('Karimatka', 'sleeping_pads', 'packed', true, 1, ''),
      s('Nepromokavá bunda', 'clothing', 'packed', true, 1, ''),
      s('Cyklo dres', 'clothing', 'worn', false, 1, ''),
      s('Cyklo kalhoty', 'clothing', 'worn', false, 1, ''),
      s('Rukavice', 'clothing', 'worn', false, 1, ''),
      s('Přilba', 'other', 'worn', true, 1, ''),
      s('Cyklo obuv', 'footwear', 'worn', true, 1, ''),
      s('Náhradní duše', 'repair', 'packed', true, 2, ''),
      s('Záplaty a montpáky', 'repair', 'packed', true, 1, ''),
      s('Multitool', 'repair', 'packed', true, 1, ''),
      s('Pumpa', 'repair', 'packed', true, 1, ''),
      s('Řetězový spojovač a olej', 'repair', 'packed', false, 1, ''),
      s('Světla přední a zadní', 'electronics', 'packed', true, 1, ''),
      s('Cyklopočítač nebo GPS', 'electronics', 'packed', false, 1, ''),
      s('Powerbanka', 'electronics', 'packed', false, 1, ''),
      s('Lahev na kolo', 'water', 'packed', true, 2, ''),
      s('Vařič', 'cooking', 'packed', false, 1, ''),
      s('Hrnec', 'cooking', 'packed', false, 1, ''),
      s('Filtr na vodu', 'water', 'packed', false, 1, ''),
      ...safety().filter((x) => x.categoryKey === 'first_aid' || x.name === 'Telefon'),
      s('Jídlo', 'food', 'consumable', true, 1, ''),
    ],
  },
  day_hike: {
    key: 'day_hike',
    name: 'Jednodenní výlet',
    description: 'Lehký batoh na celý den bez nocování.',
    activityType: 'day_hike',
    season: 'all',
    slots: [
      s('Malý batoh', 'packs', 'packed', true, 1, ''),
      s('Nepromokavá bunda', 'clothing', 'packed', true, 1, ''),
      s('Lehká izolační vrstva', 'clothing', 'packed', false, 1, ''),
      s('Čepice', 'clothing', 'packed', false, 1, ''),
      s('Turistická obuv', 'footwear', 'worn', true, 1, ''),
      s('Láhev na vodu', 'water', 'packed', true, 2, ''),
      s('Svačiny', 'food', 'consumable', true, 1, ''),
      s('Lékárnička', 'first_aid', 'packed', true, 1, ''),
      s('Čelovka', 'electronics', 'packed', true, 1, 'Pro případ zdržení do tmy.'),
      s('Telefon', 'electronics', 'packed', true, 1, ''),
      s('Powerbanka', 'electronics', 'packed', false, 1, ''),
      s('Mapa nebo záložní navigace', 'other', 'packed', true, 1, ''),
      s('Nouzová píšťalka', 'other', 'packed', false, 1, ''),
      s('Termofolie', 'other', 'packed', false, 1, ''),
      s('Opalovací krém', 'hygiene', 'packed', false, 1, ''),
      s('Kapesní nůž', 'repair', 'packed', false, 1, ''),
    ],
  },
};

export const TEMPLATE_KEYS = Object.keys(LOADOUT_TEMPLATES) as TemplateKey[];

export function getTemplate(key: TemplateKey): LoadoutTemplate {
  return LOADOUT_TEMPLATES[key];
}

export interface SlotMatch {
  slot: TemplateSlot;
  /** Best inventory match (null = nothing suitable). */
  match: GearItem | null;
  /** Other suitable items, best first. */
  alternatives: GearItem[];
}

export interface TemplateMatch {
  template: LoadoutTemplate;
  slots: SlotMatch[];
  /** Essential slots without any inventory item. */
  missingEssential: TemplateSlot[];
  /** Percent of all slots with a match. */
  coveragePct: number;
}

function slotScore(slot: TemplateSlot, item: GearItem): number {
  if (item.categoryKey !== slot.categoryKey) return -1;
  const slotTokens = tokens(slot.name);
  const hay = normalizeText(`${item.name} ${item.brand ?? ''} ${item.model ?? ''} ${item.tags.join(' ')}`);
  let hits = 0;
  for (const t of slotTokens) {
    const stem = t.length > 5 ? t.slice(0, t.length - 1) : t;
    if (hay.includes(stem)) hits++;
  }
  // categories with a single plausible item per slot (sleeping bag, pad, pack…) match without name overlap
  const singleton = ['packs', 'tents', 'tarps', 'hammocks', 'sleeping_bags', 'quilts', 'sleeping_pads', 'first_aid'].includes(slot.categoryKey);
  if (hits === 0 && !singleton) return -1;
  return hits * 10 + 1 + (item.favorite ? 0.5 : 0);
}

/**
 * Map template slots onto the user's inventory. Each inventory item is used by at most
 * `quantity` pieces across slots; same-category items need name overlap (except big-three
 * categories). No weights are invented – missing slots stay unmatched.
 */
export function matchTemplateToInventory(template: LoadoutTemplate, items: readonly GearItem[]): TemplateMatch {
  const remaining = new Map(items.map((i) => [i.id, i.quantity]));
  const slots: SlotMatch[] = template.slots.map((slot) => {
    const scored = items
      .map((item) => ({ item, score: slotScore(slot, item) }))
      .filter((x) => x.score >= 0 && (remaining.get(x.item.id) ?? 0) > 0)
      .sort((a, b) => b.score - a.score || a.item.weightG - b.item.weightG || a.item.name.localeCompare(b.item.name, 'cs'));
    const best = scored[0]?.item ?? null;
    if (best) remaining.set(best.id, (remaining.get(best.id) ?? 0) - slot.quantity);
    return { slot, match: best, alternatives: scored.slice(1, 4).map((x) => x.item) };
  });
  const matched = slots.filter((x) => x.match).length;
  return {
    template,
    slots,
    missingEssential: slots.filter((x) => !x.match && x.slot.essential).map((x) => x.slot),
    coveragePct: slots.length ? Math.round((matched / slots.length) * 100) : 0,
  };
}
