import { GearItemSchema, LoadoutItemSchema, newEntityBase } from '@trailpack/shared';
import type { CarryMode, GearItem } from '@trailpack/shared';
import type { GearEntry } from '../src/weight';

let n = 0;

export function gear(over: Partial<GearItem> & { name: string; weightG: number; categoryKey: string }): GearItem {
  n += 1;
  return GearItemSchema.parse({ ...newEntityBase(over.id ?? `g${n}`), ...over });
}

export function entry(
  item: GearItem,
  carryMode: CarryMode = 'packed',
  quantity = 1,
  extra: Partial<{ packed: boolean; notes: string }> = {},
): GearEntry {
  return {
    item,
    entry: LoadoutItemSchema.parse({ ...newEntityBase(`e-${item.id}-${carryMode}`), loadoutId: 'l1', gearItemId: item.id, quantity, carryMode, ...extra }),
  };
}
