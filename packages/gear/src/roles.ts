/**
 * Safety-relevant "roles" of gear items, detected from category and name.
 * Shared by the optimizer (what may never be removed) and the packing plan
 * (what is missing).
 */
import type { GearItem } from '@trailpack/shared';
import { matchesAnyKeyword, normalizeText } from './text';

export type GearRole =
  | 'first_aid'
  | 'light'
  | 'navigation'
  | 'water_treatment'
  | 'shelter'
  | 'sleep_bag'
  | 'sleep_pad'
  | 'rain_shell'
  | 'insulation'
  | 'emergency';

export const GEAR_ROLE_LABELS_CS: Record<GearRole, string> = {
  first_aid: 'Lékárnička',
  light: 'Čelovka / světlo',
  navigation: 'Navigace (mapa, GPS, kompas)',
  water_treatment: 'Úprava vody (filtr, tablety)',
  shelter: 'Přístřešek (stan, tarp, hamak, bivak)',
  sleep_bag: 'Spacák nebo quilt',
  sleep_pad: 'Karimatka',
  rain_shell: 'Nepromokavá vrstva',
  insulation: 'Izolační vrstva',
  emergency: 'Nouzová výbava (píšťalka, folie)',
};

/** Roles that may never be removed (replacement only under safety checks). */
export const PROTECTED_ROLES: readonly GearRole[] = [
  'first_aid',
  'light',
  'navigation',
  'water_treatment',
  'shelter',
  'sleep_bag',
  'sleep_pad',
  'rain_shell',
  'emergency',
];

const NAME_RULES: ReadonlyArray<[GearRole, readonly string[]]> = [
  ['first_aid', ['lekarn', 'first aid', 'apteczk', 'erste hilfe', 'obvaz', 'naplast']],
  ['light', ['celovk', 'headlamp', 'head torch', 'cellovk', 'latarka czolowa', 'stirnlampe', 'svitilna', 'baterk']],
  ['navigation', ['mapa', 'map', 'kompas', 'compass', 'gps', 'navigac', 'navigation', 'mapy']],
  ['water_treatment', ['filtr', 'filter', 'sawyer', 'katadyn', 'tablety na vodu', 'micropur', 'chlordioxid', 'uv sterili', 'steripen', 'water purif']],
  ['rain_shell', ['plastenk', 'rain jacket', 'rain', 'shell', 'goretex', 'gore-tex', 'nepromok', 'poncho', 'bunda proti desti', 'membran']],
  ['emergency', ['piskalk', 'whistle', 'nouzov', 'emergency', 'space blanket', 'izolacni folie', 'bivak sack', 'rescue']],
  ['insulation', ['pirov', 'down jacket', 'primaloft', 'izolacni', 'puffy', 'insulat', 'fleece', 'flis', 'mikina']],
];

/** Detect the safety role of an item, or `undefined` when it has none. */
export function gearRole(item: Pick<GearItem, 'name' | 'categoryKey' | 'waterproof'>): GearRole | undefined {
  const name = normalizeText(`${item.name}`);
  switch (item.categoryKey) {
    case 'first_aid':
      return 'first_aid';
    case 'tents':
    case 'tarps':
    case 'hammocks':
      return 'shelter';
    case 'sleeping_bags':
    case 'quilts':
      return 'sleep_bag';
    case 'sleeping_pads':
      return 'sleep_pad';
    default:
      break;
  }
  for (const [role, kws] of NAME_RULES) {
    if (!matchesAnyKeyword(name, kws)) continue;
    if (role === 'rain_shell' && item.categoryKey !== 'clothing' && !item.waterproof) continue;
    if (role === 'light' && item.categoryKey !== 'electronics' && item.categoryKey !== 'other') continue;
    if (role === 'insulation' && item.categoryKey !== 'clothing') continue;
    if (role === 'navigation' && item.categoryKey === 'packs') continue;
    return role;
  }
  return undefined;
}

export const isProtectedRole = (role: GearRole | undefined): boolean => role !== undefined && PROTECTED_ROLES.includes(role);
