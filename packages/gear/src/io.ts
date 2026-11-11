/**
 * Gear import / export: TrailPack CSV (Czech headers), LighterPack CSV, JSON, duplicate detection.
 *
 * Safety: input larger than 5 MB or looking binary is rejected; text cells that
 * start with `= + - @` are prefixed with an apostrophe on export (spreadsheet
 * formula injection) and un-prefixed on import.
 */
import { GearItemSchema, csvEscape } from '@trailpack/shared';
import type { CarryMode, GearItem } from '@trailpack/shared';
import { z } from 'zod';
import { gearCategoryName, guessGearCategoryKey } from './categories';
import { normalizeText, tokens } from './text';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const GEAR_JSON_FORMAT = 'trailpack-gear';
export const GEAR_JSON_VERSION = 1;

export const GearItemDraftSchema = GearItemSchema.omit({ id: true, createdAt: true, updatedAt: true, deletedAt: true });
/** A gear item before it is persisted (no id / timestamps). */
export type GearItemDraft = z.infer<typeof GearItemDraftSchema>;

export interface ImportIssue {
  /** 1-based line in the file (JSON: 1-based array index, 0 = whole file). */
  line: number;
  message: string;
}

export interface DraftLoadoutEntry {
  /** Index into the returned `items`. */
  itemIndex: number;
  quantity: number;
  carryMode: CarryMode;
}

export interface GearCsvParseResult {
  items: GearItemDraft[];
  /** Filled for LighterPack-style files (qty / worn / consumable are loadout properties). */
  loadoutEntries: DraftLoadoutEntry[];
  errors: ImportIssue[];
  format: 'trailpack' | 'lighterpack';
  delimiter: ',' | ';' | '\t';
}

export const GRAMS_PER_OZ = 28.349523125;
export const GRAMS_PER_LB = 453.59237;

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function utf8Length(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  return text.length;
}

/** Returns an error message when the input must be rejected, otherwise `undefined`. */
export function validateImportText(text: string): string | undefined {
  if (utf8Length(text) > MAX_IMPORT_BYTES) return 'Soubor je větší než 5 MB a nelze jej importovat.';
  const sample = text.slice(0, 8000);
  if (sample.includes('\u0000')) return 'Soubor vypadá jako binární, ne jako text (CSV/JSON).';
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13)) bad++;
  }
  if (sample.length > 0 && bad / sample.length > 0.01) return 'Soubor vypadá jako binární, ne jako text (CSV/JSON).';
  return undefined;
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

interface CsvRow {
  line: number;
  cells: string[];
}

/** Detect the delimiter from the first non-empty line (outside quotes). */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  let seen = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '"') inQ = !inQ;
    else if (!inQ) {
      if (ch === '\n' || ch === '\r') {
        if (seen) break;
      } else {
        seen = true;
        if (ch === ',' || ch === ';' || ch === '\t') counts[ch]++;
      }
    }
  }
  const order: Array<',' | ';' | '\t'> = [';', '\t', ','];
  let best: ',' | ';' | '\t' = ',';
  let max = 0;
  for (const d of order) {
    if (counts[d] > max) {
      max = counts[d];
      best = d;
    }
  }
  return best;
}

/** RFC 4180 style parser with quotes, embedded newlines and CRLF. */
function parseCsvRows(text: string, delimiter: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQ = false;
  let line = 1;
  let rowLine = 1;
  let wasQuoted = false;
  const endCell = (): void => {
    cells.push(cell);
    cell = '';
    wasQuoted = false;
  };
  const endRow = (): void => {
    endCell();
    if (cells.some((c) => c.trim() !== '')) rows.push({ line: rowLine, cells });
    cells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inQ) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && (cell === '' || !wasQuoted) && cell.trim() === '') {
      inQ = true;
      wasQuoted = true;
      cell = '';
    } else if (ch === delimiter) endCell();
    else if (ch === '\r') {
      if (text.charAt(i + 1) === '\n') i++;
      endRow();
      line++;
      rowLine = line;
    } else if (ch === '\n') {
      endRow();
      line++;
      rowLine = line;
    } else cell += ch;
  }
  if (cell !== '' || cells.length > 0) endRow();
  return rows;
}

type Field =
  | 'name'
  | 'category'
  | 'description'
  | 'qty'
  | 'weight'
  | 'unit'
  | 'url'
  | 'price'
  | 'currency'
  | 'worn'
  | 'consumable'
  | 'brand'
  | 'model'
  | 'notes'
  | 'weightSource'
  | 'weightConfirmed'
  | 'condition'
  | 'comfortTempC'
  | 'limitTempC'
  | 'rValue'
  | 'essential'
  | 'tags';

const HEADER_ALIASES: Record<Field, readonly string[]> = {
  name: ['item name', 'name', 'nazev', 'nazev veci', 'polozka', 'vec', 'item', 'vybava'],
  category: ['category', 'kategorie'],
  description: ['desc', 'description', 'popis'],
  qty: ['qty', 'quantity', 'mnozstvi', 'pocet', 'ks', 'kusu'],
  weight: ['weight', 'vaha', 'hmotnost', 'weight g', 'vaha g', 'weight oz', 'weight kg', 'weight lb'],
  unit: ['unit', 'jednotka', 'weight unit', 'vaha jednotka'],
  url: ['url', 'link', 'odkaz'],
  price: ['price', 'cena'],
  currency: ['currency', 'mena'],
  worn: ['worn', 'nosene', 'na sobe', 'obleceno', 'nosit'],
  consumable: ['consumable', 'spotrebni', 'spotrebovatelne', 'spotrebni material'],
  brand: ['brand', 'znacka', 'vyrobce'],
  model: ['model'],
  notes: ['notes', 'note', 'poznamky', 'poznamka'],
  weightSource: ['zdroj vahy', 'weight source'],
  weightConfirmed: ['potvrzena vaha', 'weight confirmed'],
  condition: ['stav', 'condition'],
  comfortTempC: ['komfortni teplota', 'komfortni teplota c', 'comfort temp', 'comfort temperature'],
  limitTempC: ['limitni teplota', 'limitni teplota c', 'limit temp', 'limit temperature'],
  rValue: ['r hodnota', 'r value', 'rvalue'],
  essential: ['nezbytne', 'essential'],
  tags: ['tagy', 'tags', 'stitky'],
};

/** Normalize a header: diacritics-free, punctuation → space; also returns a unit hint "(g)". */
function normHeader(h: string): { key: string; unitHint?: string } {
  const n = normalizeText(h.replace(/^﻿/, ''));
  const m = /\((g|kg|oz|lb|lbs)\)/.exec(n);
  const key = n.replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  return { key, unitHint: m?.[1] };
}

/** Parse a number with decimal point or decimal comma, thousands separators and currency noise. */
export function parseLocaleNumber(raw: string): number {
  const s = raw.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return NaN;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let t = s;
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    t = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    t = (s.match(/,/g) ?? []).length > 1 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if ((s.match(/\./g) ?? []).length > 1) {
    t = s.replace(/\./g, '');
  }
  return Number(t);
}

const FALSY = new Set(['', '0', 'false', 'no', 'ne', 'n', 'f', 'off', '-']);
const parseFlag = (v: string | undefined): boolean => !FALSY.has(normalizeText(v ?? ''));

/** Convert a weight with unit (g, kg, oz, lb) to grams; `undefined` for unknown units. */
export function toGrams(value: number, unit: string): number | undefined {
  switch (normalizeText(unit).replace(/\./g, '')) {
    case '':
    case 'g':
    case 'gram':
    case 'grams':
    case 'gramy':
    case 'gr':
      return value;
    case 'kg':
    case 'kilogram':
    case 'kilograms':
      return value * 1000;
    case 'oz':
    case 'ounce':
    case 'ounces':
      return value * GRAMS_PER_OZ;
    case 'lb':
    case 'lbs':
    case 'pound':
    case 'pounds':
      return value * GRAMS_PER_LB;
    default:
      return undefined;
  }
}

const CURRENCY_SYMBOLS: Array<[RegExp, string]> = [
  [/\$|usd/i, 'USD'],
  [/€|eur/i, 'EUR'],
  [/£|gbp/i, 'GBP'],
  [/kč|czk/i, 'CZK'],
  [/zł|pln/i, 'PLN'],
  [/chf/i, 'CHF'],
];

const unformula = (s: string): string => (/^'[=+\-@]/.test(s) ? s.slice(1) : s);
const formulaSafe = (s: string | undefined): string => (s !== undefined && /^[=+\-@]/.test(s) ? `'${s}` : (s ?? ''));

/**
 * Parse gear from CSV text. Auto-detects the delimiter (`,` `;` tab), strips a BOM,
 * understands Czech headers and the LighterPack export
 * (`Item Name, Category, desc, qty, weight, unit, url, price, worn, consumable`).
 * Weights are converted to grams. Row problems are reported in `errors`; usable rows are kept.
 */
export function parseGearCsv(input: string): GearCsvParseResult {
  const empty = (message: string): GearCsvParseResult => ({ items: [], loadoutEntries: [], errors: [{ line: 0, message }], format: 'trailpack', delimiter: ',' });
  const invalid = validateImportText(input);
  if (invalid) return empty(invalid);
  const text = input.replace(/^﻿/, '');
  if (text.trim() === '') return empty('Soubor je prázdný.');
  const delimiter = detectDelimiter(text);
  const rows = parseCsvRows(text, delimiter);
  const header = rows[0];
  if (!header) return empty('Soubor je prázdný.');

  const col = new Map<Field, number>();
  let unitHint: string | undefined;
  header.cells.forEach((h, i) => {
    const { key, unitHint: hint } = normHeader(h);
    for (const f of Object.keys(HEADER_ALIASES) as Field[]) {
      if (!col.has(f) && HEADER_ALIASES[f].includes(key)) {
        col.set(f, i);
        if (f === 'weight' && hint) unitHint = hint;
        if (f === 'weight' && !hint) {
          const m = /(?:weight|vaha)\s+(g|kg|oz|lb)$/.exec(key);
          if (m) unitHint = m[1];
        }
        break;
      }
    }
  });
  if (!col.has('name')) return { ...empty('Chybí sloupec s názvem položky (Název / Item Name).'), delimiter };
  const format: 'trailpack' | 'lighterpack' = col.has('worn') || col.has('consumable') || normHeader(header.cells[col.get('name')!] ?? '').key === 'item name' ? 'lighterpack' : 'trailpack';

  const items: GearItemDraft[] = [];
  const loadoutEntries: DraftLoadoutEntry[] = [];
  const errors: ImportIssue[] = [];
  const get = (cells: string[], f: Field): string => {
    const i = col.get(f);
    return i === undefined ? '' : (cells[i] ?? '').trim();
  };

  for (const row of rows.slice(1)) {
    const line = row.line;
    const name = unformula(get(row.cells, 'name'));
    if (!name) {
      errors.push({ line, message: 'Řádek bez názvu položky byl přeskočen.' });
      continue;
    }
    const categoryText = get(row.cells, 'category');
    const draft: Record<string, unknown> = {
      name: name.slice(0, 200),
      categoryKey: guessGearCategoryKey(categoryText, name),
    };
    const tags: string[] = [];
    const tagCell = get(row.cells, 'tags');
    if (tagCell) tags.push(...tagCell.split(/[|]/).map((t) => t.trim()).filter(Boolean));
    if (categoryText && draft.categoryKey === 'other' && normalizeText(categoryText) !== 'ostatni' && normalizeText(categoryText) !== 'other') tags.push(categoryText.slice(0, 40));
    if (tags.length) draft.tags = tags.map((t) => t.slice(0, 40));

    // weight
    const wRaw = get(row.cells, 'weight');
    let weightG = 0;
    let weightOk = false;
    if (wRaw !== '') {
      const v = parseLocaleNumber(wRaw);
      const unitCell = get(row.cells, 'unit');
      const unit = unitCell || unitHint || (/[a-z]+\s*$/i.exec(wRaw)?.[0] ?? 'g');
      const g = Number.isNaN(v) ? undefined : toGrams(v, unit);
      if (g === undefined) errors.push({ line, message: `Neplatná váha nebo jednotka „${wRaw} ${unitCell}“ u položky „${name}“ – nastaveno 0 g (nepotvrzeno).` });
      else if (g < 0 || g > 100000) {
        errors.push({ line, message: `Váha mimo rozsah (0–100 000 g) u položky „${name}“ – řádek přeskočen.` });
        continue;
      } else {
        weightG = Math.round(g * 10) / 10;
        weightOk = true;
      }
    } else errors.push({ line, message: `Chybí váha u položky „${name}“ – nastaveno 0 g (nepotvrzeno).` });
    draft.weightG = weightG;
    draft.weightConfirmed = weightOk;
    const wsrc = normalizeText(get(row.cells, 'weightSource'));
    draft.weightSource = (['measured', 'manufacturer', 'estimate', 'ai_estimate'] as const).find((s) => s === wsrc) ?? (weightOk ? 'measured' : 'estimate');
    const conf = get(row.cells, 'weightConfirmed');
    if (conf !== '' && weightOk) draft.weightConfirmed = parseFlag(conf);

    // qty
    const qRaw = get(row.cells, 'qty');
    let qty = 1;
    if (qRaw !== '') {
      const q = parseLocaleNumber(qRaw);
      if (Number.isNaN(q) || q < 1 || q > 999) errors.push({ line, message: `Neplatné množství „${qRaw}“ u položky „${name}“ – použito 1.` });
      else qty = Math.round(q);
    }
    if (format === 'trailpack') draft.quantity = qty;

    // price
    const pRaw = get(row.cells, 'price');
    if (pRaw !== '') {
      const p = parseLocaleNumber(pRaw);
      if (Number.isNaN(p) || p < 0) errors.push({ line, message: `Neplatná cena „${pRaw}“ u položky „${name}“ – cena vynechána.` });
      else {
        draft.price = p;
        const cur = get(row.cells, 'currency').toUpperCase();
        if (/^[A-Z]{3}$/.test(cur)) draft.currency = cur;
        else {
          const sym = CURRENCY_SYMBOLS.find(([re]) => re.test(pRaw));
          if (sym) draft.currency = sym[1];
        }
      }
    }

    const url = get(row.cells, 'url');
    if (url) {
      try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:') draft.url = u.toString();
        else errors.push({ line, message: `Odkaz „${url}“ není http(s) – vynechán.` });
      } catch {
        errors.push({ line, message: `Neplatný odkaz „${url}“ u položky „${name}“ – vynechán.` });
      }
    }
    const strField = (f: Field, key: string, max: number): void => {
      const v = unformula(get(row.cells, f));
      if (v) draft[key] = v.slice(0, max);
    };
    strField('brand', 'brand', 120);
    strField('model', 'model', 120);
    strField('description', 'description', 5000);
    strField('notes', 'notes', 5000);
    const numField = (f: Field, key: string, min: number, max: number): void => {
      const raw = get(row.cells, f);
      if (!raw) return;
      const v = parseLocaleNumber(raw);
      if (Number.isNaN(v) || v < min || v > max) errors.push({ line, message: `Neplatná hodnota „${raw}“ ve sloupci ${key} – vynecháno.` });
      else draft[key] = v;
    };
    numField('comfortTempC', 'comfortTempC', -60, 30);
    numField('limitTempC', 'limitTempC', -60, 30);
    numField('rValue', 'rValue', 0, 12);
    const cond = normalizeText(get(row.cells, 'condition'));
    const condition = (['new', 'good', 'worn', 'needs_repair', 'retired'] as const).find((c) => c === cond);
    if (condition) draft.condition = condition;
    if (get(row.cells, 'essential') !== '') draft.essential = parseFlag(get(row.cells, 'essential'));

    const parsed = GearItemDraftSchema.safeParse(draft);
    if (!parsed.success) {
      errors.push({ line, message: `Položka „${name}“ je neplatná: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
      continue;
    }
    const idx = items.push(parsed.data) - 1;
    if (format === 'lighterpack') {
      const carryMode: CarryMode = parseFlag(get(row.cells, 'worn')) ? 'worn' : parseFlag(get(row.cells, 'consumable')) ? 'consumable' : 'packed';
      loadoutEntries.push({ itemIndex: idx, quantity: qty, carryMode });
    }
  }
  return { items, loadoutEntries, errors, format, delimiter };
}

export const GEAR_CSV_HEADERS = [
  'Název',
  'Značka',
  'Model',
  'Kategorie',
  'Množství',
  'Váha (g)',
  'Zdroj váhy',
  'Potvrzená váha',
  'Cena',
  'Měna',
  'Stav',
  'URL',
  'Popis',
  'Poznámky',
  'Komfortní teplota (°C)',
  'Limitní teplota (°C)',
  'R-hodnota',
  'Nezbytné',
  'Tagy',
] as const;

/** Export gear as CSV (semicolon-delimited, UTF-8 with BOM → opens correctly in Czech Excel). */
export function exportGearCsv(items: ReadonlyArray<GearItem | GearItemDraft>): string {
  const lines = [GEAR_CSV_HEADERS.map(csvEscape).join(';')];
  for (const it of items) {
    const cells: unknown[] = [
      formulaSafe(it.name),
      formulaSafe(it.brand),
      formulaSafe(it.model),
      gearCategoryName(it.categoryKey, 'cs'),
      it.quantity,
      it.weightG,
      it.weightSource,
      it.weightConfirmed ? 'ano' : 'ne',
      it.price ?? '',
      it.price !== undefined ? it.currency : '',
      it.condition,
      it.url ?? '',
      formulaSafe(it.description),
      formulaSafe(it.notes),
      it.comfortTempC ?? '',
      it.limitTempC ?? '',
      it.rValue ?? '',
      it.essential ? 'ano' : 'ne',
      it.tags.join('|'),
    ];
    lines.push(cells.map(csvEscape).join(';'));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

const GearJsonEnvelopeSchema = z.object({
  format: z.literal(GEAR_JSON_FORMAT),
  version: z.number().int().min(1),
  exportedAt: z.string().optional(),
  items: z.array(z.unknown()),
});

/** Export gear as versioned JSON. `exportedAt` defaults to the current time. */
export function exportGearJson(items: ReadonlyArray<GearItem | GearItemDraft>, exportedAt: string = new Date().toISOString()): string {
  const clean = items.map((it) => GearItemDraftSchema.parse(it));
  return JSON.stringify({ format: GEAR_JSON_FORMAT, version: GEAR_JSON_VERSION, exportedAt, items: clean }, null, 2);
}

export interface GearJsonParseResult {
  items: GearItemDraft[];
  errors: ImportIssue[];
  version?: number;
}

/** Parse the JSON produced by {@link exportGearJson} (a bare array of items is accepted too). */
export function parseGearJson(input: string): GearJsonParseResult {
  const fail = (message: string): GearJsonParseResult => ({ items: [], errors: [{ line: 0, message }] });
  const invalid = validateImportText(input);
  if (invalid) return fail(invalid);
  let data: unknown;
  try {
    data = JSON.parse(input.replace(/^﻿/, ''));
  } catch {
    return fail('Neplatný JSON – soubor nelze přečíst.');
  }
  let rawItems: unknown[];
  let version: number | undefined;
  if (Array.isArray(data)) rawItems = data;
  else {
    const env = GearJsonEnvelopeSchema.safeParse(data);
    if (!env.success) return fail('Soubor není export vybavení TrailPack (chybí „format“ a „version“).');
    if (env.data.version > GEAR_JSON_VERSION) return fail(`Verze exportu ${env.data.version} je novější než podporovaná ${GEAR_JSON_VERSION}. Aktualizujte aplikaci.`);
    rawItems = env.data.items;
    version = env.data.version;
  }
  const items: GearItemDraft[] = [];
  const errors: ImportIssue[] = [];
  rawItems.forEach((raw, i) => {
    const p = GearItemDraftSchema.safeParse(raw);
    if (p.success) items.push(p.data);
    else errors.push({ line: i + 1, message: `Položka ${i + 1} je neplatná: ${p.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}` });
  });
  return { items, errors, version };
}

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

export interface DuplicateGroup {
  /** Indexes into the input array. */
  indices: number[];
  ids: Array<string | undefined>;
  reason: 'exact' | 'similar';
  /** Czech description. */
  message: string;
}

type DupInput = Pick<GearItemDraft, 'name' | 'brand' | 'model' | 'weightG' | 'categoryKey'> & { id?: string };

/**
 * Find probable duplicates: identical brand+model+name, or very similar names
 * (token overlap ≥ 75 %) in the same category with weights within 5 % (min 5 g).
 */
export function findDuplicates(items: readonly DupInput[]): DuplicateGroup[] {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b);
  };
  const full = items.map((it) => normalizeText(`${it.brand ?? ''} ${it.model ?? ''} ${it.name}`).replace(/[^a-z0-9]+/g, ' ').trim());
  const toks = items.map((it) => new Set(tokens(`${it.brand ?? ''} ${it.model ?? ''} ${it.name}`)));
  const exactPair = new Set<string>();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (a.categoryKey !== b.categoryKey) continue;
      if (full[i] !== '' && full[i] === full[j]) {
        union(i, j);
        exactPair.add(`${i}:${j}`);
        continue;
      }
      const ta = toks[i]!;
      const tb = toks[j]!;
      if (ta.size === 0 || tb.size === 0) continue;
      let inter = 0;
      for (const t of ta) if (tb.has(t)) inter++;
      const jac = inter / (ta.size + tb.size - inter);
      const tol = Math.max(5, 0.05 * Math.max(a.weightG, b.weightG));
      if (jac >= 0.75 && Math.abs(a.weightG - b.weightG) <= tol) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(i);
  }
  const out: DuplicateGroup[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const exact = idxs.every((i) => full[i] === full[idxs[0]!]);
    out.push({
      indices: idxs,
      ids: idxs.map((i) => items[i]!.id),
      reason: exact ? 'exact' : 'similar',
      message: exact ? `Stejná položka „${items[idxs[0]!]!.name}“ je v seznamu ${idxs.length}×.` : `Podobné položky: ${idxs.map((i) => `„${items[i]!.name}“`).join(', ')}.`,
    });
  }
  return out.sort((a, b) => a.indices[0]! - b.indices[0]!);
}
