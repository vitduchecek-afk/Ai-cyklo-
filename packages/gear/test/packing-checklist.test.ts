import { describe, expect, it } from 'vitest';
import { TripSchema, newEntityBase } from '@trailpack/shared';
import { estimateVolumeL, packingPlan, packingProgress, recommendPackLocation } from '../src/packing';
import { generateTripChecklist, mergeChecklist } from '../src/checklist';
import { LOADOUT_TEMPLATES, TEMPLATE_KEYS, matchTemplateToInventory } from '../src/templates';
import { entry, gear } from './helpers';

describe('recommendPackLocation', () => {
  const loc = (name: string, categoryKey: string, weightG = 300, mode: 'packed' | 'worn' | 'consumable' = 'packed', notes?: string) => {
    const e = entry(gear({ name, categoryKey, weightG }), mode, 1, { notes });
    return recommendPackLocation(e.item, e.entry);
  };
  it('puts sleeping bag to the bottom and food/water close to the back', () => {
    expect(loc('Spacák', 'sleeping_bags').location).toBe('bottom');
    expect(loc('Ovesná kaše', 'food', 500, 'consumable').location).toBe('middle_back');
    expect(loc('Vodní vak', 'water', 1000).location).toBe('middle_back');
  });
  it('keeps frequently used and emergency items accessible', () => {
    expect(loc('Nepromokavá bunda', 'clothing').location).toBe('lid');
    expect(loc('Lékárnička', 'first_aid').location).toBe('lid');
    expect(loc('Čelovka', 'electronics', 80).location).toBe('lid');
    expect(loc('Energy bar', 'food', 60).location).toBe('hip_belt');
    expect(loc('Sawyer filtr', 'water', 80).location).toBe('side_pocket');
  });
  it('electronics in a waterproof bag, wet tarp outside', () => {
    const e = loc('Powerbanka', 'electronics', 250);
    expect(e.waterproofBag).toBe(true);
    expect(loc('Tarp', 'tarps', 400).location).toBe('front_pocket');
    expect(loc('Stan', 'tents', 1500, 'packed', 'mokrý').location).toBe('front_pocket');
    expect(loc('Boty', 'footwear', 600, 'worn').location).toBe('worn');
  });
});

describe('packingPlan', () => {
  const entries = [
    entry(gear({ name: 'Spacák', categoryKey: 'sleeping_bags', weightG: 900 })),
    entry(gear({ name: 'Jídlo', categoryKey: 'food', weightG: 2000 }), 'consumable'),
    entry(gear({ name: 'Bunda', categoryKey: 'clothing', weightG: 300 })),
    entry(gear({ name: 'Boty', categoryKey: 'footwear', weightG: 700 }), 'worn'),
  ];
  it('computes distribution, volume and missing essentials', () => {
    const p = packingPlan(entries, 40);
    expect(p.weightDistribution.bottomG).toBe(900);
    expect(p.weightDistribution.middleBackG).toBe(2000);
    expect(p.weightDistribution.wornG).toBe(700);
    expect(p.volume.estimated).toBe(true);
    expect(p.volume.usedL).toBeCloseTo(8 + 1 + 1.5, 5);
    expect(p.volume.fillPct).toBe(Math.round((10.5 / 40) * 100));
    expect(p.balanceScore).toBeGreaterThan(0);
    expect(p.balanceScore).toBeLessThanOrEqual(100);
    expect(p.missingEssentials.map((m) => m.role)).toEqual(expect.arrayContaining(['first_aid', 'light', 'shelter']));
    expect(packingPlan(entries, 40, { dayTrip: true }).missingEssentials.map((m) => m.role)).not.toContain('shelter');
  });
  it('respects manual pack location and user volume', () => {
    const item = gear({ name: 'Něco', categoryKey: 'other', weightG: 100, volumeL: 2, volumeEstimated: false });
    expect(estimateVolumeL(item)).toEqual({ volumeL: 2, estimated: false });
    const e = entry(item);
    e.entry.packLocation = 'top';
    expect(packingPlan([e]).zones.top?.[0]?.manual).toBe(true);
  });
  it('tracks progress', () => {
    const e = [entry(gear({ name: 'A', categoryKey: 'other', weightG: 100 }), 'packed', 1, { packed: true }), entry(gear({ name: 'B', categoryKey: 'other', weightG: 300 })), entries[3]!];
    const pr = packingProgress(e);
    expect(pr).toMatchObject({ packed: 1, total: 2, pct: 50, pctWeight: 25 });
    expect(pr.remaining.map((r) => r.name)).toEqual(['B']);
  });
});

describe('checklist', () => {
  const trip = TripSchema.parse({ ...newEntityBase('trip1'), name: 'Výlet', settings: {} });
  const base = {
    trip,
    days: 3,
    hasRoute: true,
    offlineRegionReady: false,
    transportLegs: [],
    participants: 2,
    emergencyContactsSet: true,
    now: new Date('2026-06-01T12:00:00Z'),
  };
  it('covers all categories and derives done states', () => {
    const items = generateTripChecklist({
      ...base,
      forecastFetchedAt: '2026-06-01T10:00:00Z',
      campsites: [{ name: 'Kemp Sever', reservation: 'required' }, { reservation: 'no' }],
    });
    const cats = new Set(items.map((i) => i.category));
    for (const c of ['gear', 'food', 'water', 'electronics', 'charging', 'offline_maps', 'forecast', 'permits', 'transport', 'safety']) expect(cats.has(c as never)).toBe(true);
    const by = (k: string) => items.find((i) => i.autoKey === k);
    expect(by('offline:route')?.done).toBe(true);
    expect(by('offline:region')?.done).toBe(false);
    expect(by('forecast:fresh')?.done).toBe(true);
    expect(by('permits:reserve:0')?.text).toContain('Kemp Sever');
    expect(by('safety:group')).toBeDefined();
    expect(new Set(items.map((i) => i.autoKey)).size).toBe(items.length);
  });
  it('flags stale forecast and missing gear essentials', () => {
    const items = generateTripChecklist({ ...base, forecastFetchedAt: '2026-05-30T10:00:00Z', loadoutEntries: [entry(gear({ name: 'Něco', categoryKey: 'other', weightG: 10 }))] });
    expect(items.find((i) => i.autoKey === 'forecast:fresh')).toMatchObject({ done: false });
    expect(items.some((i) => i.autoKey === 'gear:missing:first_aid')).toBe(true);
  });
  it('merges: keeps user items and done state, adds new, removes stale undone', () => {
    const gen = generateTripChecklist({ ...base, forecastFetchedAt: '2026-06-01T10:00:00Z' });
    const existing = [
      { id: '1', text: 'Vzít fotku babičky', category: 'other' as const, done: false },
      { id: '2', text: 'stará', category: 'water' as const, done: true, autoKey: 'water:plan' },
      { id: '3', text: 'zastaralá nedokončená', category: 'gear' as const, done: false, autoKey: 'gone:1' },
      { id: '4', text: 'zastaralá hotová', category: 'gear' as const, done: true, autoKey: 'gone:2' },
    ];
    const merged = mergeChecklist(existing, gen);
    expect(merged.find((m) => 'id' in m && m.id === '1')).toBeDefined();
    expect(merged.find((m) => 'id' in m && m.id === '2')).toMatchObject({ done: true, text: gen.find((g) => g.autoKey === 'water:plan')?.text });
    expect(merged.find((m) => 'id' in m && m.id === '3')).toBeUndefined();
    expect(merged.find((m) => 'id' in m && m.id === '4')).toBeDefined();
    expect(merged.filter((m) => m.autoKey === 'water:plan')).toHaveLength(1);
    expect(merged.length).toBe(1 + 1 + 1 + (gen.length - 1));
  });
});

describe('templates', () => {
  it('defines all templates without any weight fields', () => {
    expect(TEMPLATE_KEYS.sort()).toEqual(['bikepacking', 'camping', 'day_hike', 'summer_trek', 'ultralight', 'weekend_bivouac', 'winter_hike']);
    for (const t of Object.values(LOADOUT_TEMPLATES)) {
      expect(t.slots.length).toBeGreaterThan(10);
      for (const s of t.slots) expect(Object.keys(s).sort()).toEqual(['carryMode', 'categoryKey', 'essential', 'name', 'note', 'quantity']);
    }
  });
  it('matches inventory and reports missing essentials', () => {
    const items = [
      gear({ name: 'Můj batoh 40 l', categoryKey: 'packs', weightG: 900 }),
      gear({ name: 'Lékárnička malá', categoryKey: 'first_aid', weightG: 150 }),
      gear({ name: 'Čelovka Petzl', categoryKey: 'electronics', weightG: 80 }),
    ];
    const m = matchTemplateToInventory(LOADOUT_TEMPLATES.day_hike, items);
    expect(m.slots.find((s) => s.slot.name === 'Malý batoh')?.match?.name).toBe('Můj batoh 40 l');
    expect(m.slots.find((s) => s.slot.name === 'Čelovka')?.match?.name).toBe('Čelovka Petzl');
    expect(m.missingEssential.map((s) => s.name)).toContain('Nepromokavá bunda');
    expect(m.coveragePct).toBeGreaterThan(0);
    expect(m.coveragePct).toBeLessThan(100);
  });
});
