import { describe, expect, it } from 'vitest';
import { exportGearCsv, exportGearJson, findDuplicates, parseGearCsv, parseGearJson, GRAMS_PER_OZ } from '../src/io';
import { gear } from './helpers';

const LIGHTERPACK = `Item Name,Category,desc,qty,weight,unit,url,price,worn,consumable
Zpacked Duplex,Shelter,2P tent,1,19.0,oz,https://example.com/duplex,$699.00,,
"Quilt, 20F",Sleep,"down, 20F",1,1.4,lb,,,,
Smartwool socks,Clothing,,2,60,g,,,Worn,
Oatmeal,Food,,3,0.1,kg,,,,Consumable
Bad row,Misc,,1,abc,g,,,,
`;

describe('parseGearCsv', () => {
  it('parses LighterPack exports and converts units to grams', () => {
    const r = parseGearCsv(LIGHTERPACK);
    expect(r.format).toBe('lighterpack');
    expect(r.delimiter).toBe(',');
    expect(r.items).toHaveLength(5);
    expect(r.items[0]).toMatchObject({ name: 'Zpacked Duplex', weightG: Math.round(19 * GRAMS_PER_OZ * 10) / 10, price: 699, currency: 'USD', categoryKey: 'tents' });
    expect(r.items[1]?.name).toBe('Quilt, 20F');
    expect(r.items[1]?.weightG).toBeCloseTo(1.4 * 453.59237, 0);
    expect(r.items[3]?.weightG).toBe(100);
    expect(r.loadoutEntries.map((e) => [e.quantity, e.carryMode])).toEqual([
      [1, 'packed'],
      [1, 'packed'],
      [2, 'worn'],
      [3, 'consumable'],
      [1, 'packed'],
    ]);
    expect(r.items[4]?.weightConfirmed).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.line).toBe(6);
  });

  it('parses Czech semicolon files with BOM and decimal comma', () => {
    const csv = '﻿Název;Kategorie;Množství;Váha (g);Cena\nStan Naturehike;Stany;1;1 250,5;3 990 Kč\nKarimatka;Karimatky;1;"480";1200\n';
    const r = parseGearCsv(csv);
    expect(r.delimiter).toBe(';');
    expect(r.errors).toEqual([]);
    expect(r.items[0]).toMatchObject({ name: 'Stan Naturehike', categoryKey: 'tents', weightG: 1250.5, price: 3990, currency: 'CZK', quantity: 1 });
    expect(r.items[1]?.categoryKey).toBe('sleeping_pads');
  });

  it('detects tab delimiter and handles quoted newlines', () => {
    const r = parseGearCsv('name\tweight\tunit\n"Hrnec\ntitan"\t95\tg\n');
    expect(r.delimiter).toBe('\t');
    expect(r.items[0]?.name).toBe('Hrnec\ntitan');
    expect(r.items[0]?.weightG).toBe(95);
  });

  it('rejects binary, oversized and headerless input', () => {
    expect(parseGearCsv('PK\u0003\u0004\u0000\u0000abc').errors[0]?.message).toMatch(/binární/);
    expect(parseGearCsv('a'.repeat(5 * 1024 * 1024 + 1)).errors[0]?.message).toMatch(/5 MB/);
    expect(parseGearCsv('foo,bar\n1,2').errors[0]?.message).toMatch(/Chybí sloupec/);
    expect(parseGearCsv('').items).toEqual([]);
  });

  it('round-trips through export', () => {
    const items = [
      gear({ name: '=SUM(A1)', weightG: 100.5, categoryKey: 'other', price: 20, currency: 'EUR', quantity: 2, tags: ['a', 'b'] }),
      gear({ name: 'Spacák; "extrém"', brand: 'Značka', model: 'X1', weightG: 900, categoryKey: 'sleeping_bags', comfortTempC: -3, limitTempC: -9, essential: true, weightConfirmed: false, weightSource: 'estimate' }),
    ];
    const csv = exportGearCsv(items);
    expect(csv.startsWith('﻿')).toBe(true);
    const r = parseGearCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ name: '=SUM(A1)', weightG: 100.5, price: 20, currency: 'EUR', quantity: 2, tags: ['a', 'b'] });
    expect(r.items[1]).toMatchObject({
      name: 'Spacák; "extrém"',
      brand: 'Značka',
      model: 'X1',
      categoryKey: 'sleeping_bags',
      comfortTempC: -3,
      limitTempC: -9,
      essential: true,
      weightConfirmed: false,
      weightSource: 'estimate',
    });
  });
});

describe('gear JSON', () => {
  it('round-trips and validates', () => {
    const items = [gear({ name: 'Stan', weightG: 1000, categoryKey: 'tents' })];
    const json = exportGearJson(items, '2026-01-01T00:00:00.000Z');
    expect(JSON.parse(json)).toMatchObject({ format: 'trailpack-gear', version: 1 });
    const r = parseGearJson(json);
    expect(r.errors).toEqual([]);
    expect(r.items[0]).toMatchObject({ name: 'Stan', weightG: 1000 });
    expect('id' in (r.items[0] ?? {})).toBe(false);
  });
  it('reports per-item errors, newer versions and garbage', () => {
    const bad = JSON.stringify({ format: 'trailpack-gear', version: 1, items: [{ name: 'ok', weightG: 1, categoryKey: 'other' }, { name: '', weightG: -1 }] });
    const r = parseGearJson(bad);
    expect(r.items).toHaveLength(1);
    expect(r.errors[0]?.line).toBe(2);
    expect(parseGearJson(JSON.stringify({ format: 'trailpack-gear', version: 99, items: [] })).errors[0]?.message).toMatch(/novější/);
    expect(parseGearJson('{nope').errors[0]?.message).toMatch(/JSON/);
    expect(parseGearJson('{"a":1}').errors).toHaveLength(1);
  });
});

describe('findDuplicates', () => {
  it('finds exact and similar duplicates', () => {
    const items = [
      gear({ id: 'a', name: 'Hrnec titanový', brand: 'Toaks', weightG: 100, categoryKey: 'cooking' }),
      gear({ id: 'b', name: 'hrnec Titanový', brand: 'toaks', weightG: 100, categoryKey: 'cooking' }),
      gear({ id: 'c', name: 'Titanový hrnec Toaks 750', weightG: 102, categoryKey: 'cooking' }),
      gear({ id: 'd', name: 'Stan', weightG: 1000, categoryKey: 'tents' }),
    ];
    const d = findDuplicates(items);
    expect(d).toHaveLength(1);
    expect(d[0]?.ids.sort()).toEqual(['a', 'b', 'c']);
    expect(findDuplicates(items.slice(0, 2))[0]?.reason).toBe('exact');
  });
});
