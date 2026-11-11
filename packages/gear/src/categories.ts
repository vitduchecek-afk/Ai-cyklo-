/**
 * Built-in gear categories (one per {@link GearCategoryKey}) with Czech names,
 * icon names, accessible colours and translations.
 *
 * Colours are mid-tone so that they reach at least 3:1 contrast (WCAG 2.2
 * SC 1.4.11, non-text UI) both on white (#FFFFFF, light theme) and on the
 * dark theme background #121A14.
 */
import { GearCategoryKeySchema, newEntityBase } from '@trailpack/shared';
import type { GearCategory, GearCategoryKey, Language } from '@trailpack/shared';
import { matchesAnyKeyword, normalizeText } from './text';

export interface GearCategoryDefinition {
  key: GearCategoryKey;
  /** Czech display name (primary UI language). */
  name: string;
  /** Short icon identifier understood by the UI icon set. */
  icon: string;
  /** Hex colour `#RRGGBB`, ≥ 3:1 contrast on white and on #121A14. */
  color: string;
  sortOrder: number;
}

/** Background colours the category palette is validated against. */
export const CATEGORY_COLOR_BACKGROUNDS = { light: '#FFFFFF', dark: '#121A14' } as const;

export const DEFAULT_GEAR_CATEGORIES: readonly GearCategoryDefinition[] = [
  { key: 'packs', name: 'Batohy', icon: 'backpack', color: '#D73D6E', sortOrder: 0 },
  { key: 'tents', name: 'Stany', icon: 'tent', color: '#1D7F24', sortOrder: 1 },
  { key: 'tarps', name: 'Tarpy', icon: 'tarp', color: '#5C9420', sortOrder: 2 },
  { key: 'hammocks', name: 'Hamaky', icon: 'hammock', color: '#1C8A51', sortOrder: 3 },
  { key: 'sleeping_bags', name: 'Spacáky', icon: 'sleeping-bag', color: '#7268E0', sortOrder: 4 },
  { key: 'quilts', name: 'Quilty', icon: 'quilt', color: '#9858DD', sortOrder: 5 },
  { key: 'sleeping_pads', name: 'Karimatky', icon: 'sleeping-pad', color: '#C334D6', sortOrder: 6 },
  { key: 'clothing', name: 'Oblečení', icon: 'shirt', color: '#D530A6', sortOrder: 7 },
  { key: 'footwear', name: 'Obuv', icon: 'boot', color: '#8D6E4F', sortOrder: 8 },
  { key: 'cooking', name: 'Vaření', icon: 'stove', color: '#B06724', sortOrder: 9 },
  { key: 'water', name: 'Voda', icon: 'droplet', color: '#2282A7', sortOrder: 10 },
  { key: 'electronics', name: 'Elektronika', icon: 'battery', color: '#4675D9', sortOrder: 11 },
  { key: 'hygiene', name: 'Hygiena', icon: 'soap', color: '#1C877A', sortOrder: 12 },
  { key: 'first_aid', name: 'Lékárnička', icon: 'first-aid', color: '#D64639', sortOrder: 13 },
  { key: 'repair', name: 'Opravy', icon: 'wrench', color: '#6F8590', sortOrder: 14 },
  { key: 'food', name: 'Jídlo', icon: 'food', color: '#9A7B00', sortOrder: 15 },
  { key: 'other', name: 'Ostatní', icon: 'package', color: '#8A7F74', sortOrder: 16 },
];

/** Category names per UI language. Czech names equal {@link DEFAULT_GEAR_CATEGORIES}. */
export const GEAR_CATEGORY_TRANSLATIONS: Record<Language, Record<GearCategoryKey, string>> = {
  cs: Object.fromEntries(DEFAULT_GEAR_CATEGORIES.map((c) => [c.key, c.name])) as Record<GearCategoryKey, string>,
  en: {
    packs: 'Backpacks',
    tents: 'Tents',
    tarps: 'Tarps',
    hammocks: 'Hammocks',
    sleeping_bags: 'Sleeping bags',
    quilts: 'Quilts',
    sleeping_pads: 'Sleeping pads',
    clothing: 'Clothing',
    footwear: 'Footwear',
    cooking: 'Cooking',
    water: 'Water',
    electronics: 'Electronics',
    hygiene: 'Hygiene',
    first_aid: 'First aid',
    repair: 'Repair',
    food: 'Food',
    other: 'Other',
  },
  sk: {
    packs: 'Batohy',
    tents: 'Stany',
    tarps: 'Tarpy',
    hammocks: 'Hojdacie siete',
    sleeping_bags: 'Spacáky',
    quilts: 'Quilty',
    sleeping_pads: 'Karimatky',
    clothing: 'Oblečenie',
    footwear: 'Obuv',
    cooking: 'Varenie',
    water: 'Voda',
    electronics: 'Elektronika',
    hygiene: 'Hygiena',
    first_aid: 'Lekárnička',
    repair: 'Opravy',
    food: 'Jedlo',
    other: 'Ostatné',
  },
  pl: {
    packs: 'Plecaki',
    tents: 'Namioty',
    tarps: 'Tarpy',
    hammocks: 'Hamaki',
    sleeping_bags: 'Śpiwory',
    quilts: 'Quilty',
    sleeping_pads: 'Karimaty',
    clothing: 'Odzież',
    footwear: 'Obuwie',
    cooking: 'Gotowanie',
    water: 'Woda',
    electronics: 'Elektronika',
    hygiene: 'Higiena',
    first_aid: 'Apteczka',
    repair: 'Naprawy',
    food: 'Jedzenie',
    other: 'Inne',
  },
  de: {
    packs: 'Rucksäcke',
    tents: 'Zelte',
    tarps: 'Tarps',
    hammocks: 'Hängematten',
    sleeping_bags: 'Schlafsäcke',
    quilts: 'Quilts',
    sleeping_pads: 'Isomatten',
    clothing: 'Bekleidung',
    footwear: 'Schuhe',
    cooking: 'Kochen',
    water: 'Wasser',
    electronics: 'Elektronik',
    hygiene: 'Hygiene',
    first_aid: 'Erste Hilfe',
    repair: 'Reparatur',
    food: 'Verpflegung',
    other: 'Sonstiges',
  },
};

const CATEGORY_BY_KEY = new Map<string, GearCategoryDefinition>(DEFAULT_GEAR_CATEGORIES.map((c) => [c.key, c]));

export const isGearCategoryKey = (key: string): key is GearCategoryKey => GearCategoryKeySchema.safeParse(key).success;

export const getGearCategory = (key: string): GearCategoryDefinition | undefined => CATEGORY_BY_KEY.get(key);

/** Localised category name; unknown (user-defined) keys are returned unchanged. */
export function gearCategoryName(key: string, language: Language = 'cs'): string {
  if (!isGearCategoryKey(key)) return key;
  return GEAR_CATEGORY_TRANSLATIONS[language][key];
}

/** Build persistable {@link GearCategory} entities for the built-in categories. */
export function builtinGearCategoryEntities(language: Language = 'cs'): GearCategory[] {
  return DEFAULT_GEAR_CATEGORIES.map((c) => ({
    ...newEntityBase(`builtin:${c.key}`),
    key: c.key,
    name: GEAR_CATEGORY_TRANSLATIONS[language][c.key],
    icon: c.icon,
    color: c.color,
    builtin: true,
    sortOrder: c.sortOrder,
  }));
}

/**
 * Keyword table used to guess a category from free text (imported CSV
 * category, LighterPack list category or item name). Keywords are
 * diacritic-free, lower-case and matched at word start. Order matters: more
 * specific categories first.
 */
const CATEGORY_KEYWORDS: ReadonlyArray<[GearCategoryKey, readonly string[]]> = [
  ['first_aid', ['first aid', 'lekarn', 'apteczk', 'erste hilfe', 'medical', 'med kit', 'naplast', 'obvaz', 'bandage', 'leky', 'zdravot']],
  ['quilts', ['quilt']],
  ['sleeping_bags', ['spacak', 'spaci pytel', 'sleeping bag', 'spiwor', 'schlafsack', 'sleep system']],
  ['sleeping_pads', ['karimat', 'sleeping pad', 'pad', 'matrac', 'isomat', 'nafukovaci podlozk', 'mattress']],
  ['hammocks', ['hamak', 'hammock', 'hojdac', 'hangemat']],
  ['tarps', ['tarp', 'plachta']],
  ['tents', ['stan', 'tent', 'namiot', 'zelt', 'shelter', 'pristresek', 'bivak', 'bivy']],
  ['packs', ['batoh', 'backpack', 'pack', 'rucksack', 'plecak', 'brasn', 'bikepacking bag', 'frame bag', 'saddle bag', 'brasna']],
  ['footwear', ['obuv', 'bot', 'boty', 'shoe', 'boot', 'footwear', 'sandal', 'trail runner', 'obuwie', 'schuh', 'snezniky', 'gaiter', 'navlek']],
  ['water', ['water', 'voda', 'vod', 'woda', 'wasser', 'filtr', 'filter', 'lahev', 'lahv', 'bottle', 'flask', 'hydrat']],
  ['cooking', ['cook', 'kitchen', 'vareni', 'varic', 'stove', 'hrnec', 'esus', 'pot', 'kartus', 'canister', 'fuel', 'palivo', 'spork', 'lzic', 'kuchyn', 'gotowan', 'kochen']],
  ['electronics', ['electr', 'elektr', 'phone', 'telefon', 'powerbank', 'power bank', 'baterie', 'battery', 'headlamp', 'celovk', 'charger', 'nabij', 'kabel', 'cable', 'gps', 'camera', 'fotoapar', 'hodink', 'watch']],
  ['hygiene', ['hygien', 'toilet', 'toalet', 'wash', 'mydl', 'kartacek', 'toothbrush', 'toothpaste', 'zubni', 'sunscreen', 'opalov', 'rucnik', 'towel', 'higien']],
  ['repair', ['repair', 'oprav', 'tape', 'pasku', 'paska', 'duct', 'naradi', 'tool', 'multitool', 'siti', 'sewing', 'lepen', 'patch', 'zaplat', 'naprawa', 'reparatur']],
  ['food', ['food', 'jidlo', 'jedlo', 'snack', 'svacin', 'meal', 'jedzen', 'verpfleg', 'consumable']],
  ['clothing', ['cloth', 'obleceni', 'oblecen', 'wear', 'worn', 'jacket', 'bunda', 'kalhot', 'pants', 'shirt', 'tricko', 'triko', 'socks', 'ponozk', 'fleece', 'flis', 'mikin', 'cepic', 'hat', 'glove', 'rukavic', 'odziez', 'bekleid', 'vrstv', 'layer']],
];

/**
 * Best-effort mapping of free text (category label and/or item name) to a
 * built-in category key. Exact keys and localised names win over keywords.
 * Returns `'other'` when nothing matches.
 */
export function guessGearCategoryKey(...texts: ReadonlyArray<string | undefined | null>): GearCategoryKey {
  for (const raw of texts) {
    if (!raw) continue;
    const t = normalizeText(raw);
    if (!t) continue;
    const asKey = t.replace(/[\s-]+/g, '_');
    if (isGearCategoryKey(asKey)) return asKey;
    for (const lang of Object.keys(GEAR_CATEGORY_TRANSLATIONS) as Language[]) {
      const names = GEAR_CATEGORY_TRANSLATIONS[lang];
      for (const key of Object.keys(names) as GearCategoryKey[]) {
        if (normalizeText(names[key]) === t) return key;
      }
    }
  }
  for (const raw of texts) {
    if (!raw) continue;
    const t = normalizeText(raw);
    for (const [key, keywords] of CATEGORY_KEYWORDS) {
      if (matchesAnyKeyword(t, keywords)) return key;
    }
  }
  return 'other';
}
