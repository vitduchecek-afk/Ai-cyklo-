import { describe, expect, it } from 'vitest';
import { calculatePackWeight, classifyBaseWeight, compareLoadouts } from '../src/weight';
import { DEFAULT_GEAR_CATEGORIES, guessGearCategoryKey } from '../src/categories';
import { entry, gear } from './helpers';

describe('calculatePackWeight', () => {
  const tent = gear({ id: 't', name: 'Stan', weightG: 1000, categoryKey: 'tents' });
  const sock = gear({ id: 's', name: 'Ponožky', weightG: 50, categoryKey: 'clothing' });
  const shoe = gear({ id: 'sh', name: 'Boty', weightG: 600, categoryKey: 'footwear', weightConfirmed: false });
  const food = gear({ id: 'f', name: 'Ovesné vločky', weightG: 500, categoryKey: 'food' });
  const book = gear({ id: 'b', name: 'Kniha', weightG: 300, categoryKey: 'other' });

  const entries = [entry(tent), entry(sock, 'packed', 3), entry(shoe, 'worn'), entry(food, 'consumable', 2), entry(book, 'optional')];

  it('multiplies by quantity and splits modes', () => {
    const w = calculatePackWeight(entries);
    expect(w.baseG).toBe(1000 + 150 + 300);
    expect(w.wornG).toBe(600);
    expect(w.consumableG).toBe(1000);
    expect(w.optionalG).toBe(300);
    expect(w.carriedG).toBe(w.baseG + w.consumableG);
    expect(w.totalG).toBe(w.carriedG + 600);
    expect(w.itemCount).toBe(1 + 3 + 1 + 2 + 1);
    expect(w.unconfirmedCount).toBe(1);
    expect(w.byCategory.clothing?.baseG).toBe(150);
    expect(w.byCategory.footwear?.wornG).toBe(600);
  });

  it('can exclude optional items from base weight', () => {
    const w = calculatePackWeight(entries, { includeOptional: false });
    expect(w.baseG).toBe(1150);
    expect(w.optionalG).toBe(300);
  });

  it('adds extra consumables and lists heaviest items', () => {
    const w = calculatePackWeight(entries, { consumables: { foodG: 100, waterG: 1000, fuelG: 200 } });
    expect(w.consumableG).toBe(1000 + 1300);
    expect(w.byCategory.water?.consumableG).toBe(1000);
    expect(w.heaviest.map((h) => h.name).slice(0, 2).sort()).toEqual(['Ovesné vločky', 'Stan']);
    expect(w.heaviest[0]?.share).toBeCloseTo(1000 / w.totalG, 6);
  });

  it('classifies base weight', () => {
    expect(classifyBaseWeight(2299)).toBe('super_ultralight');
    expect(classifyBaseWeight(2300)).toBe('ultralight');
    expect(classifyBaseWeight(4499)).toBe('ultralight');
    expect(classifyBaseWeight(8999)).toBe('lightweight');
    expect(classifyBaseWeight(9000)).toBe('traditional');
  });

  it('compares loadouts', () => {
    const lighter = [entry(tent), entry(sock, 'packed', 1), entry(shoe, 'worn')];
    const c = compareLoadouts(entries, lighter);
    expect(c.totals.baseG).toBe(1050 - 1450);
    expect(c.onlyInA.map((x) => x.name)).toContain('Kniha');
    expect(c.changed.find((x) => x.itemId === 's')?.diffG).toBe(-100);
    expect(c.byCategory.find((x) => x.categoryKey === 'other')?.diffG).toBe(-300);
  });
});

describe('categories', () => {
  it('has 17 categories with distinct colours', () => {
    expect(DEFAULT_GEAR_CATEGORIES).toHaveLength(17);
    expect(new Set(DEFAULT_GEAR_CATEGORIES.map((c) => c.color)).size).toBe(17);
  });
  it('guesses categories from text', () => {
    expect(guessGearCategoryKey('Spacáky')).toBe('sleeping_bags');
    expect(guessGearCategoryKey('', 'Sawyer filtr')).toBe('water');
    expect(guessGearCategoryKey('Big Three', 'Plastová láhev')).toBe('water');
    expect(guessGearCategoryKey('xyz', 'abc')).toBe('other');
  });
});
