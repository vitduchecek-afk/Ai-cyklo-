/**
 * KML 2.2 import (Placemark with Point / LineString / LinearRing / MultiGeometry,
 * gx:Track, gx:MultiTrack; nested Document/Folder) and export
 * (Document with Styles, LineString clamped to ground, Points).
 *
 * KML coordinates are `lon,lat[,alt]` tuples, altitude in meters.
 */
import type { Position, TrackPoint } from '@trailpack/shared';
import { TrailPackError } from '@trailpack/shared';
import { DEFAULT_MAX_BYTES, child, childText, children, isValidLatLon, num, parseTime, parseXmlDocument, textOf, xmlText } from './xml';
import type { XmlNode } from './xml';

export interface KmlLine {
  name?: string;
  description?: string;
  /** Geometry element the line came from. */
  kind: 'LineString' | 'Track' | 'LinearRing';
  points: TrackPoint[];
}

export interface KmlPoint {
  lat: number;
  lon: number;
  ele?: number;
  name?: string;
  description?: string;
}

export interface KmlDocument {
  name?: string;
  description?: string;
  lines: KmlLine[];
  points: KmlPoint[];
  warnings: string[];
}

export interface ParseKmlOptions {
  maxBytes?: number;
}

interface ParseCtx {
  warnings: Set<string>;
  invalid: number;
  lines: KmlLine[];
  points: KmlPoint[];
}

/** Parses a KML `<coordinates>` string ("lon,lat[,alt] lon,lat[,alt] …"). */
export function parseKmlCoordinates(text: string | undefined, ctx?: { invalid: number }): TrackPoint[] {
  if (!text) return [];
  const out: TrackPoint[] = [];
  for (const tuple of text.trim().split(/\s+/)) {
    if (!tuple) continue;
    const parts = tuple.split(',');
    const lon = num(parts[0]);
    const lat = num(parts[1]);
    if (!isValidLatLon(lat, lon)) {
      if (ctx) ctx.invalid++;
      continue;
    }
    const p: TrackPoint = { lat: lat!, lon: lon! };
    const ele = num(parts[2]);
    if (ele !== undefined) p.ele = ele;
    out.push(p);
  }
  return out;
}

function parseTrack(track: XmlNode, ctx: ParseCtx): TrackPoint[] {
  const whens = children(track, 'when').map((w) => textOf(w));
  const coords = children(track, 'coord').map((c) => textOf(c));
  const pts: TrackPoint[] = [];
  coords.forEach((c, i) => {
    if (!c) return;
    // gx:coord is space separated: "lon lat alt"
    const [lonS, latS, altS] = c.trim().split(/\s+/);
    const lon = num(lonS);
    const lat = num(latS);
    if (!isValidLatLon(lat, lon)) {
      ctx.invalid++;
      return;
    }
    const p: TrackPoint = { lat: lat!, lon: lon! };
    const ele = num(altS);
    if (ele !== undefined) p.ele = ele;
    const t = parseTime(whens[i]);
    if (t !== undefined) p.time = t;
    pts.push(p);
  });
  return pts;
}

function collectGeometry(node: XmlNode, meta: { name?: string; description?: string }, ctx: ParseCtx): void {
  for (const p of children(node, 'Point')) {
    const pts = parseKmlCoordinates(childText(p, 'coordinates'), ctx);
    for (const pt of pts) ctx.points.push({ ...pt, ...meta });
  }
  for (const ls of children(node, 'LineString')) {
    const pts = parseKmlCoordinates(childText(ls, 'coordinates'), ctx);
    if (pts.length) ctx.lines.push({ ...meta, kind: 'LineString', points: pts });
  }
  for (const lr of children(node, 'LinearRing')) {
    const pts = parseKmlCoordinates(childText(lr, 'coordinates'), ctx);
    if (pts.length) ctx.lines.push({ ...meta, kind: 'LinearRing', points: pts });
  }
  for (const tr of children(node, 'Track')) {
    const pts = parseTrack(tr, ctx);
    if (pts.length) ctx.lines.push({ ...meta, kind: 'Track', points: pts });
  }
  for (const mt of children(node, 'MultiTrack')) collectGeometry(mt, meta, ctx);
  for (const mg of children(node, 'MultiGeometry')) collectGeometry(mg, meta, ctx);
  if (children(node, 'Polygon').length) ctx.warnings.add('Polygony (plochy) byly při importu KML ignorovány.');
  if (children(node, 'Model').length) ctx.warnings.add('3D modely byly při importu KML ignorovány.');
}

function collectContainer(node: XmlNode, ctx: ParseCtx, depth: number): void {
  if (depth > 50) return;
  for (const pm of children(node, 'Placemark')) {
    const meta: { name?: string; description?: string } = {};
    const name = childText(pm, 'name');
    const description = childText(pm, 'description');
    if (name) meta.name = name;
    if (description) meta.description = description;
    collectGeometry(pm, meta, ctx);
  }
  for (const d of children(node, 'Document')) collectContainer(d, ctx, depth + 1);
  for (const f of children(node, 'Folder')) collectContainer(f, ctx, depth + 1);
  if (children(node, 'NetworkLink').length) ctx.warnings.add('Síťové odkazy (NetworkLink) se nenačítají.');
}

/**
 * Parses a KML document.
 * @throws TrailPackError `too_large`, `invalid_input`, `parse_error`.
 */
export function parseKml(xml: string, opts: ParseKmlOptions = {}): KmlDocument {
  const doc = parseXmlDocument(xml, { maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES, formatLabel: 'KML' });
  const root = child(doc, 'kml');
  if (!root) throw new TrailPackError('parse_error', 'Soubor není ve formátu KML (chybí kořenový element <kml>).');
  const ctx: ParseCtx = { warnings: new Set(), invalid: 0, lines: [], points: [] };
  collectContainer(root, ctx, 0);
  const document = child(root, 'Document') ?? child(root, 'Folder');
  if (ctx.invalid > 0) ctx.warnings.add(`Přeskočeno ${ctx.invalid} bodů s neplatnými souřadnicemi.`);
  // Many exporters write altitude 0 for clampToGround lines – that is "no elevation", not sea level.
  for (const line of ctx.lines) {
    if (line.points.length > 1 && line.points.every((p) => p.ele === undefined || p.ele === 0)) {
      for (const p of line.points) delete p.ele;
    }
  }
  return {
    name: (document && childText(document, 'name')) ?? undefined,
    description: (document && childText(document, 'description')) ?? undefined,
    lines: ctx.lines,
    points: ctx.points,
    warnings: [...ctx.warnings],
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface KmlExportInput {
  name: string;
  description?: string;
  lines?: Array<{ name?: string; description?: string; points: Array<TrackPoint | Position>; color?: string; widthPx?: number }>;
  points?: Array<{ lat: number; lon: number; ele?: number; name?: string; description?: string }>;
  /** Default line color as `#RRGGBB` (default TrailPack green). */
  lineColor?: string;
}

/** `#RRGGBB` (optionally with alpha `#RRGGBBAA`) → KML `aabbggrr`. */
export function hexToKmlColor(hex: string, alpha = 255): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return 'ff3a6b2f';
  const a = m[4] ?? alpha.toString(16).padStart(2, '0');
  return `${a}${m[3]}${m[2]}${m[1]}`.toLowerCase();
}

const fmt = (v: number, d: number): string => String(Math.round(v * 10 ** d) / 10 ** d);

function coordString(p: TrackPoint | Position): string {
  const lon = Array.isArray(p) ? p[0] : p.lon;
  const lat = Array.isArray(p) ? p[1] : p.lat;
  const ele = Array.isArray(p) ? p[2] : p.ele;
  if (!isValidLatLon(lat, lon)) throw new TrailPackError('invalid_input', `Neplatné souřadnice pro export KML: ${lat}, ${lon}.`);
  return ele !== undefined && Number.isFinite(ele) ? `${fmt(lon, 7)},${fmt(lat, 7)},${fmt(ele, 1)}` : `${fmt(lon, 7)},${fmt(lat, 7)}`;
}

/** Builds a KML 2.2 document with a shared line style and waypoint style. */
export function exportKml(input: KmlExportInput): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<kml xmlns="http://www.opengis.net/kml/2.2">');
  out.push('<Document>');
  out.push(`  <name>${xmlText(input.name)}</name>`);
  if (input.description) out.push(`  <description>${xmlText(input.description)}</description>`);
  const defaultColor = hexToKmlColor(input.lineColor ?? '#2F6B3A');
  out.push(`  <Style id="trailpack-route"><LineStyle><color>${defaultColor}</color><width>4</width></LineStyle></Style>`);
  out.push('  <Style id="trailpack-point"><IconStyle><color>ff2f6b3a</color><scale>1.1</scale></IconStyle><LabelStyle><scale>0.9</scale></LabelStyle></Style>');
  (input.lines ?? []).forEach((line, i) => {
    if (line.color || line.widthPx) {
      out.push(
        `  <Style id="trailpack-route-${i}"><LineStyle><color>${hexToKmlColor(line.color ?? input.lineColor ?? '#2F6B3A')}</color><width>${line.widthPx ?? 4}</width></LineStyle></Style>`,
      );
    }
  });
  (input.lines ?? []).forEach((line, i) => {
    out.push('  <Placemark>');
    if (line.name) out.push(`    <name>${xmlText(line.name)}</name>`);
    if (line.description) out.push(`    <description>${xmlText(line.description)}</description>`);
    out.push(`    <styleUrl>#${line.color || line.widthPx ? `trailpack-route-${i}` : 'trailpack-route'}</styleUrl>`);
    out.push('    <LineString>');
    out.push('      <tessellate>1</tessellate>');
    out.push('      <altitudeMode>clampToGround</altitudeMode>');
    out.push(`      <coordinates>${line.points.map(coordString).join(' ')}</coordinates>`);
    out.push('    </LineString>');
    out.push('  </Placemark>');
  });
  for (const p of input.points ?? []) {
    out.push('  <Placemark>');
    if (p.name) out.push(`    <name>${xmlText(p.name)}</name>`);
    if (p.description) out.push(`    <description>${xmlText(p.description)}</description>`);
    out.push('    <styleUrl>#trailpack-point</styleUrl>');
    out.push(`    <Point><altitudeMode>clampToGround</altitudeMode><coordinates>${coordString({ lat: p.lat, lon: p.lon, ele: p.ele })}</coordinates></Point>`);
    out.push('  </Placemark>');
  }
  out.push('</Document>');
  out.push('</kml>');
  return `${out.join('\n')}\n`;
}
