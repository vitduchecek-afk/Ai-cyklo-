/**
 * GPX 1.0 / 1.1 import and GPX 1.1 export.
 *
 * - Namespace prefixes are supported (`<gpx:trkpt>`), `<extensions>` are ignored.
 * - Times are epoch milliseconds in `TrackPoint.time`; metadata times are ISO strings.
 * - Elevations are meters above sea level, coordinates WGS84 degrees.
 */
import type { Position, TrackPoint } from '@trailpack/shared';
import { TrailPackError } from '@trailpack/shared';
import { DEFAULT_MAX_BYTES, attr, child, childText, children, isValidLatLon, num, parseTime, parseXmlDocument, xmlText } from './xml';
import type { XmlNode } from './xml';

export interface GpxWaypoint {
  lat: number;
  lon: number;
  /** meters */
  ele?: number;
  /** epoch ms */
  time?: number;
  name?: string;
  desc?: string;
  sym?: string;
  type?: string;
}

export interface GpxTrack {
  name?: string;
  description?: string;
  type?: string;
  segments: TrackPoint[][];
}

export interface GpxRoute {
  name?: string;
  description?: string;
  points: TrackPoint[];
}

export interface GpxDocument {
  /** '1.0' | '1.1' (as declared by the file, if any). */
  version?: string;
  creator?: string;
  name?: string;
  description?: string;
  author?: string;
  /** ISO date-time from metadata. */
  time?: string;
  tracks: GpxTrack[];
  routes: GpxRoute[];
  waypoints: GpxWaypoint[];
  /** Non-fatal problems found while reading (Czech). */
  warnings: string[];
}

export interface ParseGpxOptions {
  /** Maximum accepted size in bytes (default 20 MB). */
  maxBytes?: number;
}

function readPoint(node: XmlNode, stats: { invalid: number }): TrackPoint | undefined {
  const lat = num(attr(node, 'lat'));
  const lon = num(attr(node, 'lon'));
  if (!isValidLatLon(lat, lon)) {
    stats.invalid++;
    return undefined;
  }
  const p: TrackPoint = { lat: lat!, lon: lon! };
  const ele = num(childText(node, 'ele'));
  if (ele !== undefined) p.ele = ele;
  const time = parseTime(childText(node, 'time'));
  if (time !== undefined) p.time = time;
  // GPX 1.0 allows <speed> (m/s) directly in trkpt.
  const speed = num(childText(node, 'speed'));
  if (speed !== undefined && speed >= 0) p.speed = speed;
  return p;
}

function readAuthor(meta: XmlNode | undefined, root: XmlNode): string | undefined {
  if (meta) {
    const author = child(meta, 'author');
    if (author) return childText(author, 'name') ?? childText(meta, 'author');
  }
  // GPX 1.0: <author> is a plain string on the root.
  return childText(root, 'author');
}

/**
 * Parses a GPX 1.0 or 1.1 document.
 * @throws TrailPackError `too_large`, `invalid_input` (empty), `parse_error` (malformed / not GPX / DTD entities).
 */
export function parseGpx(xml: string, opts: ParseGpxOptions = {}): GpxDocument {
  const doc = parseXmlDocument(xml, { maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES, formatLabel: 'GPX' });
  const root = child(doc, 'gpx');
  if (!root) {
    throw new TrailPackError('parse_error', 'Soubor není ve formátu GPX (chybí kořenový element <gpx>).');
  }
  const warnings: string[] = [];
  const stats = { invalid: 0 };
  const meta = child(root, 'metadata');
  const result: GpxDocument = {
    version: attr(root, 'version'),
    creator: attr(root, 'creator'),
    name: (meta && childText(meta, 'name')) ?? childText(root, 'name'),
    description: (meta && childText(meta, 'desc')) ?? childText(root, 'desc'),
    author: readAuthor(meta, root),
    tracks: [],
    routes: [],
    waypoints: [],
    warnings,
  };
  const metaTime = parseTime((meta && childText(meta, 'time')) ?? childText(root, 'time'));
  if (metaTime !== undefined) result.time = new Date(metaTime).toISOString();

  for (const trk of children(root, 'trk')) {
    const segments: TrackPoint[][] = [];
    for (const seg of children(trk, 'trkseg')) {
      const pts: TrackPoint[] = [];
      for (const pt of children(seg, 'trkpt')) {
        const p = readPoint(pt, stats);
        if (p) pts.push(p);
      }
      if (pts.length) segments.push(pts);
    }
    result.tracks.push({ name: childText(trk, 'name'), description: childText(trk, 'desc'), type: childText(trk, 'type'), segments });
  }

  for (const rte of children(root, 'rte')) {
    const points: TrackPoint[] = [];
    for (const pt of children(rte, 'rtept')) {
      const p = readPoint(pt, stats);
      if (p) points.push(p);
    }
    result.routes.push({ name: childText(rte, 'name'), description: childText(rte, 'desc'), points });
  }

  for (const w of children(root, 'wpt')) {
    const p = readPoint(w, stats);
    if (!p) continue;
    const wp: GpxWaypoint = { lat: p.lat, lon: p.lon };
    if (p.ele !== undefined) wp.ele = p.ele;
    if (p.time !== undefined) wp.time = p.time;
    const name = childText(w, 'name');
    const desc = childText(w, 'desc') ?? childText(w, 'cmt');
    const sym = childText(w, 'sym');
    const type = childText(w, 'type');
    if (name) wp.name = name;
    if (desc) wp.desc = desc;
    if (sym) wp.sym = sym;
    if (type) wp.type = type;
    result.waypoints.push(wp);
  }

  if (stats.invalid > 0) {
    warnings.push(`Přeskočeno ${stats.invalid} bodů s neplatnými souřadnicemi.`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** A point for export: a TrackPoint (`{lat, lon, ele?, time?}`) or a GeoJSON position `[lon, lat, ele?]`. */
export type ExportPoint = TrackPoint | Position;

export interface GpxExportWaypoint {
  lat: number;
  lon: number;
  ele?: number;
  /** epoch ms, ISO string or Date */
  time?: number | string | Date;
  name?: string;
  desc?: string;
  sym?: string;
  type?: string;
}

export interface GpxExportInput {
  name: string;
  description?: string;
  author?: string;
  /** Document time (epoch ms, ISO string or Date). Defaults to none. */
  time?: number | string | Date;
  link?: { href: string; text?: string };
  /** Each track becomes one `<trk>`; use `segments` to export multiple `<trkseg>`. */
  tracks?: Array<{ name?: string; description?: string; type?: string; points?: ExportPoint[]; segments?: ExportPoint[][] }>;
  routes?: Array<{ name?: string; description?: string; points: ExportPoint[] }>;
  waypoints?: GpxExportWaypoint[];
}

interface NormPoint {
  lat: number;
  lon: number;
  ele?: number;
  time?: number;
}

function normPoint(p: ExportPoint): NormPoint {
  if (Array.isArray(p)) {
    const out: NormPoint = { lon: p[0], lat: p[1] };
    if (p.length > 2 && Number.isFinite(p[2])) out.ele = p[2];
    return out;
  }
  const tp = p as TrackPoint;
  return { lat: tp.lat, lon: tp.lon, ele: tp.ele, time: tp.time };
}

function toIso(t: number | string | Date | undefined): string | undefined {
  if (t === undefined) return undefined;
  const d = t instanceof Date ? t : new Date(t);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

const fmtCoord = (v: number): string => String(Math.round(v * 1e7) / 1e7);
const fmtEle = (v: number): string => String(Math.round(v * 10) / 10);

function pointXml(tag: 'trkpt' | 'rtept' | 'wpt', p: NormPoint & { name?: string; desc?: string; sym?: string; type?: string; timeIso?: string }, indent: string): string {
  if (!isValidLatLon(p.lat, p.lon)) {
    throw new TrailPackError('invalid_input', `Neplatné souřadnice pro export GPX: ${p.lat}, ${p.lon}.`);
  }
  const inner: string[] = [];
  if (p.ele !== undefined && Number.isFinite(p.ele)) inner.push(`<ele>${fmtEle(p.ele)}</ele>`);
  const time = p.timeIso ?? toIso(p.time);
  if (time) inner.push(`<time>${time}</time>`);
  if (p.name) inner.push(`<name>${xmlText(p.name)}</name>`);
  if (p.desc) inner.push(`<desc>${xmlText(p.desc)}</desc>`);
  if (p.sym) inner.push(`<sym>${xmlText(p.sym)}</sym>`);
  if (p.type) inner.push(`<type>${xmlText(p.type)}</type>`);
  const open = `${indent}<${tag} lat="${fmtCoord(p.lat)}" lon="${fmtCoord(p.lon)}"`;
  return inner.length ? `${open}>${inner.join('')}</${tag}>` : `${open}/>`;
}

/**
 * Builds a GPX 1.1 document (creator="TrailPack") with metadata, waypoints,
 * routes and tracks. All text is XML-escaped; times are ISO 8601 UTC.
 */
export function exportGpx(input: GpxExportInput): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<gpx version="1.1" creator="TrailPack" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
  );

  // Collect all points to compute bounds.
  const all: NormPoint[] = [];
  const tracks = (input.tracks ?? []).map((t) => ({
    ...t,
    segs: (t.segments ?? (t.points ? [t.points] : [])).map((seg) => seg.map(normPoint)),
  }));
  const routes = (input.routes ?? []).map((r) => ({ ...r, pts: r.points.map(normPoint) }));
  for (const t of tracks) for (const s of t.segs) all.push(...s);
  for (const r of routes) all.push(...r.pts);
  for (const w of input.waypoints ?? []) all.push(w as NormPoint);

  // <metadata> children order per GPX 1.1 XSD: name, desc, author, copyright, link, time, keywords, bounds.
  const meta: string[] = [];
  meta.push(`    <name>${xmlText(input.name)}</name>`);
  if (input.description) meta.push(`    <desc>${xmlText(input.description)}</desc>`);
  if (input.author) meta.push(`    <author><name>${xmlText(input.author)}</name></author>`);
  if (input.link?.href) {
    meta.push(
      `    <link href="${xmlText(input.link.href)}">${input.link.text ? `<text>${xmlText(input.link.text)}</text>` : ''}</link>`,
    );
  }
  const docTime = toIso(input.time);
  if (docTime) meta.push(`    <time>${docTime}</time>`);
  const valid = all.filter((p) => isValidLatLon(p.lat, p.lon));
  if (valid.length) {
    let minLat = Infinity;
    let minLon = Infinity;
    let maxLat = -Infinity;
    let maxLon = -Infinity;
    for (const p of valid) {
      minLat = Math.min(minLat, p.lat);
      maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon);
      maxLon = Math.max(maxLon, p.lon);
    }
    meta.push(`    <bounds minlat="${fmtCoord(minLat)}" minlon="${fmtCoord(minLon)}" maxlat="${fmtCoord(maxLat)}" maxlon="${fmtCoord(maxLon)}"/>`);
  }
  lines.push('  <metadata>', ...meta, '  </metadata>');

  for (const w of input.waypoints ?? []) {
    lines.push(pointXml('wpt', { lat: w.lat, lon: w.lon, ele: w.ele, timeIso: toIso(w.time), name: w.name, desc: w.desc, sym: w.sym, type: w.type }, '  '));
  }

  for (const r of routes) {
    lines.push('  <rte>');
    if (r.name) lines.push(`    <name>${xmlText(r.name)}</name>`);
    if (r.description) lines.push(`    <desc>${xmlText(r.description)}</desc>`);
    for (const p of r.pts) lines.push(pointXml('rtept', p, '    '));
    lines.push('  </rte>');
  }

  for (const t of tracks) {
    lines.push('  <trk>');
    if (t.name) lines.push(`    <name>${xmlText(t.name)}</name>`);
    if (t.description) lines.push(`    <desc>${xmlText(t.description)}</desc>`);
    if (t.type) lines.push(`    <type>${xmlText(t.type)}</type>`);
    for (const seg of t.segs) {
      lines.push('    <trkseg>');
      for (const p of seg) lines.push(pointXml('trkpt', p, '      '));
      lines.push('    </trkseg>');
    }
    lines.push('  </trk>');
  }

  lines.push('</gpx>');
  return `${lines.join('\n')}\n`;
}
