/**
 * GeoJSON (RFC 7946) import and export.
 *
 * Supported input: FeatureCollection, Feature, bare Geometry, GeometryCollection;
 * geometry types LineString, MultiLineString, Point, MultiPoint (others are skipped with a warning).
 * Positions are `[lon, lat, ele?]`, elevation in meters, WGS84.
 */
import type { Position } from '@trailpack/shared';
import { TrailPackError } from '@trailpack/shared';
import { DEFAULT_MAX_BYTES, assertMaxSize, isValidLatLon, stripBom } from './xml';

export interface GeoJsonLine {
  name?: string;
  description?: string;
  positions: Position[];
}

export interface GeoJsonPoint {
  lat: number;
  lon: number;
  ele?: number;
  name?: string;
  description?: string;
}

export interface GeoJsonDocument {
  name?: string;
  lines: GeoJsonLine[];
  points: GeoJsonPoint[];
  warnings: string[];
}

export interface ParseGeoJsonOptions {
  maxBytes?: number;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

function readPosition(raw: unknown, ctx: { invalid: number }): Position | undefined {
  if (!Array.isArray(raw) || raw.length < 2) {
    ctx.invalid++;
    return undefined;
  }
  const lon = raw[0];
  const lat = raw[1];
  if (typeof lon !== 'number' || typeof lat !== 'number' || !isValidLatLon(lat, lon)) {
    ctx.invalid++;
    return undefined;
  }
  const ele = raw[2];
  return typeof ele === 'number' && Number.isFinite(ele) ? [lon, lat, ele] : [lon, lat];
}

function readLine(raw: unknown, ctx: { invalid: number }): Position[] {
  if (!Array.isArray(raw)) {
    ctx.invalid++;
    return [];
  }
  const out: Position[] = [];
  for (const c of raw) {
    const p = readPosition(c, ctx);
    if (p) out.push(p);
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function visit(node: unknown, meta: { name?: string; description?: string }, doc: GeoJsonDocument, ctx: { invalid: number; skipped: Set<string> }, depth: number): void {
  if (!isObj(node) || depth > 20) return;
  const type = node.type;
  if (type === 'FeatureCollection') {
    if (!doc.name) doc.name = str(node.name);
    if (Array.isArray(node.features)) for (const f of node.features) visit(f, {}, doc, ctx, depth + 1);
    return;
  }
  if (type === 'Feature') {
    const props = isObj(node.properties) ? node.properties : {};
    const m = { name: str(props.name) ?? str(props.title), description: str(props.description) ?? str(props.desc) };
    visit(node.geometry, m, doc, ctx, depth + 1);
    return;
  }
  const withMeta = <T extends object>(o: T): T => {
    if (meta.name) (o as { name?: string }).name = meta.name;
    if (meta.description) (o as { description?: string }).description = meta.description;
    return o;
  };
  switch (type) {
    case 'LineString': {
      const positions = readLine(node.coordinates, ctx);
      if (positions.length >= 2) doc.lines.push(withMeta({ positions }));
      break;
    }
    case 'MultiLineString': {
      if (Array.isArray(node.coordinates)) {
        for (const part of node.coordinates) {
          const positions = readLine(part, ctx);
          if (positions.length >= 2) doc.lines.push(withMeta({ positions }));
        }
      }
      break;
    }
    case 'Point': {
      const p = readPosition(node.coordinates, ctx);
      if (p) doc.points.push(withMeta({ lon: p[0], lat: p[1], ...(p.length > 2 ? { ele: p[2] } : {}) }));
      break;
    }
    case 'MultiPoint': {
      if (Array.isArray(node.coordinates)) {
        for (const c of node.coordinates) {
          const p = readPosition(c, ctx);
          if (p) doc.points.push(withMeta({ lon: p[0], lat: p[1], ...(p.length > 2 ? { ele: p[2] } : {}) }));
        }
      }
      break;
    }
    case 'GeometryCollection': {
      if (Array.isArray(node.geometries)) for (const g of node.geometries) visit(g, meta, doc, ctx, depth + 1);
      break;
    }
    case 'Polygon':
    case 'MultiPolygon':
      ctx.skipped.add('Polygony (plochy) byly při importu GeoJSON ignorovány.');
      break;
    default:
      break;
  }
}

/**
 * Parses GeoJSON given as a string or an already parsed object.
 * @throws TrailPackError `too_large`, `parse_error` (invalid JSON / not GeoJSON).
 */
export function parseGeoJson(input: string | object, opts: ParseGeoJsonOptions = {}): GeoJsonDocument {
  let data: unknown = input;
  if (typeof input === 'string') {
    assertMaxSize(input, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    try {
      data = JSON.parse(stripBom(input));
    } catch (e) {
      throw new TrailPackError('parse_error', 'Soubor GeoJSON není platný JSON.', { cause: e });
    }
  }
  if (!isObj(data) || typeof data.type !== 'string') {
    throw new TrailPackError('parse_error', 'Soubor není ve formátu GeoJSON (chybí vlastnost "type").');
  }
  const doc: GeoJsonDocument = { name: str(data.name), lines: [], points: [], warnings: [] };
  const ctx = { invalid: 0, skipped: new Set<string>() };
  visit(data, {}, doc, ctx, 0);
  if (ctx.invalid > 0) doc.warnings.push(`Přeskočeno ${ctx.invalid} bodů s neplatnými souřadnicemi.`);
  doc.warnings.push(...ctx.skipped);
  return doc;
}

export interface GeoJsonExportInput {
  name?: string;
  lines?: Array<{ name?: string; description?: string; positions: Position[]; properties?: Record<string, unknown> }>;
  points?: GeoJsonPoint[];
}

const r7 = (v: number): number => Math.round(v * 1e7) / 1e7;

/** Builds a GeoJSON FeatureCollection string (coordinates rounded to 7 decimals ≈ 1 cm). */
export function exportGeoJson(input: GeoJsonExportInput, pretty = false): string {
  const features: unknown[] = [];
  for (const l of input.lines ?? []) {
    const coordinates = l.positions.map((p) => {
      if (!isValidLatLon(p[1], p[0])) throw new TrailPackError('invalid_input', `Neplatné souřadnice pro export GeoJSON: ${p[1]}, ${p[0]}.`);
      return p.length > 2 ? [r7(p[0]), r7(p[1]), Math.round(p[2] * 10) / 10] : [r7(p[0]), r7(p[1])];
    });
    features.push({
      type: 'Feature',
      properties: { ...(l.properties ?? {}), ...(l.name ? { name: l.name } : {}), ...(l.description ? { description: l.description } : {}) },
      geometry: { type: 'LineString', coordinates },
    });
  }
  for (const p of input.points ?? []) {
    if (!isValidLatLon(p.lat, p.lon)) throw new TrailPackError('invalid_input', `Neplatné souřadnice pro export GeoJSON: ${p.lat}, ${p.lon}.`);
    features.push({
      type: 'Feature',
      properties: { ...(p.name ? { name: p.name } : {}), ...(p.description ? { description: p.description } : {}) },
      geometry: { type: 'Point', coordinates: p.ele !== undefined ? [r7(p.lon), r7(p.lat), p.ele] : [r7(p.lon), r7(p.lat)] },
    });
  }
  const fc: Json = { type: 'FeatureCollection', ...(input.name ? { name: input.name } : {}), features };
  return JSON.stringify(fc, null, pretty ? 2 : undefined);
}
