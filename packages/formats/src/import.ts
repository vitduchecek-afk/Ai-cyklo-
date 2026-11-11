/**
 * One-stop route file import: sniff the format, parse it and normalise the
 * result to a single geometry + waypoints with distance / ascent / descent.
 */
import type { Position } from '@trailpack/shared';
import { TrailPackError } from '@trailpack/shared';
import { cumulativeDistances, elevationStats, simplifyLine } from '@trailpack/calculations';
import { parseGpx } from './gpx';
import { parseKml } from './kml';
import { parseGeoJson } from './geojson';
import { DEFAULT_MAX_BYTES, assertMaxSize, stripBom } from './xml';

export type RouteFileFormat = 'gpx' | 'kml' | 'geojson';

export interface ImportedWaypoint {
  lat: number;
  lon: number;
  /** meters */
  ele?: number;
  name?: string;
  description?: string;
}

export interface ImportedRoute {
  name: string;
  description?: string;
  /** `[lon, lat, ele?]`, possibly simplified when the source exceeded `maxPoints`. */
  geometry: Position[];
  waypoints: ImportedWaypoint[];
  /** Length of the original (unsimplified) line, meters. */
  distanceM: number;
  ascentM: number;
  descentM: number;
  hasElevation: boolean;
  hasTime: boolean;
  /** Number of points in the source line (before simplification). */
  pointCount: number;
  sourceFormat: RouteFileFormat;
  /** Czech, user-facing notes about what was changed or skipped. */
  warnings: string[];
}

export interface ImportRouteOptions {
  /** Default 20 MB. */
  maxBytes?: number;
  /** Geometry is simplified down to at most this many points. Default 50 000. */
  maxPoints?: number;
}

/**
 * Detects the format from content (preferred) and filename extension (fallback).
 * Returns null when nothing matches.
 */
export function detectFormat(content: string, filename?: string): RouteFileFormat | null {
  const head = stripBom(content).slice(0, 4096).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'geojson';
  if (head.startsWith('<')) {
    if (/<(?:\w+:)?gpx[\s>]/i.test(head)) return 'gpx';
    if (/<(?:\w+:)?kml[\s>]/i.test(head)) return 'kml';
  }
  const ext = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === 'gpx') return 'gpx';
  if (ext === 'kml') return 'kml';
  if (ext === 'geojson' || ext === 'json') return 'geojson';
  // The root element may come after a long XML prolog / comments.
  if (head.startsWith('<')) {
    const rest = stripBom(content);
    if (/<(?:\w+:)?gpx[\s>]/i.test(rest)) return 'gpx';
    if (/<(?:\w+:)?kml[\s>]/i.test(rest)) return 'kml';
  }
  return null;
}

interface RawImport {
  name?: string;
  description?: string;
  /** Candidate lines with their own point lists and optional times. */
  lines: Array<{ name?: string; positions: Position[]; hasTime: boolean; gaps: number }>;
  waypoints: ImportedWaypoint[];
  warnings: string[];
}

function fromGpx(content: string, maxBytes: number): RawImport {
  const gpx = parseGpx(content, { maxBytes });
  const lines: RawImport['lines'] = [];
  const toPos = (p: { lat: number; lon: number; ele?: number }): Position => (p.ele !== undefined ? [p.lon, p.lat, p.ele] : [p.lon, p.lat]);
  for (const t of gpx.tracks) {
    const positions: Position[] = [];
    let hasTime = false;
    for (const seg of t.segments) for (const p of seg) {
      positions.push(toPos(p));
      if (p.time !== undefined) hasTime = true;
    }
    if (positions.length) lines.push({ name: t.name, positions, hasTime, gaps: Math.max(0, t.segments.length - 1) });
  }
  if (lines.length === 0) {
    for (const r of gpx.routes) {
      if (r.points.length) lines.push({ name: r.name, positions: r.points.map(toPos), hasTime: r.points.some((p) => p.time !== undefined), gaps: 0 });
    }
  }
  return {
    name: gpx.name,
    description: gpx.description,
    lines,
    waypoints: gpx.waypoints.map((w) => ({ lat: w.lat, lon: w.lon, ele: w.ele, name: w.name, description: w.desc })),
    warnings: [...gpx.warnings],
  };
}

function fromKml(content: string, maxBytes: number): RawImport {
  const kml = parseKml(content, { maxBytes });
  const lines: RawImport['lines'] = kml.lines
    .filter((l) => l.kind !== 'LinearRing' || l.points.length > 1)
    .map((l) => ({
      name: l.name,
      positions: l.points.map((p): Position => (p.ele !== undefined ? [p.lon, p.lat, p.ele] : [p.lon, p.lat])),
      hasTime: l.points.some((p) => p.time !== undefined),
      gaps: 0,
    }));
  return {
    name: kml.name,
    description: kml.description,
    lines,
    waypoints: kml.points.map((p) => ({ lat: p.lat, lon: p.lon, ele: p.ele, name: p.name, description: p.description })),
    warnings: [...kml.warnings],
  };
}

function fromGeoJson(content: string, maxBytes: number): RawImport {
  const gj = parseGeoJson(content, { maxBytes });
  return {
    name: gj.name,
    lines: gj.lines.map((l) => ({ name: l.name, positions: l.positions, hasTime: false, gaps: 0 })),
    waypoints: gj.points.map((p) => ({ lat: p.lat, lon: p.lon, ele: p.ele, name: p.name, description: p.description })),
    warnings: [...gj.warnings],
  };
}

/** Simplifies `line` to at most `maxPoints`, raising the tolerance until it fits. */
function reduceLine(line: Position[], maxPoints: number): Position[] {
  if (line.length <= maxPoints) return line;
  let tol = 1;
  let out = line;
  for (let i = 0; i < 12 && out.length > maxPoints; i++) {
    out = simplifyLine(line, tol);
    tol *= 2;
  }
  if (out.length > maxPoints) {
    // Last resort: uniform decimation (keeps first and last point).
    const step = (out.length - 1) / (maxPoints - 1);
    const picked: Position[] = [];
    for (let i = 0; i < maxPoints; i++) picked.push(out[Math.round(i * step)]!);
    out = picked;
  }
  return out;
}

/**
 * Imports a GPX / KML / GeoJSON file into a normalised route.
 * With several tracks, the one with most points is used. Multiple segments of
 * a track are joined.
 *
 * @throws TrailPackError `too_large`, `parse_error` (unknown format, no line geometry), `invalid_input`.
 */
export function importRouteFile(content: string, filename?: string, opts: ImportRouteOptions = {}): ImportedRoute {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxPoints = Math.max(2, opts.maxPoints ?? 50_000);
  assertMaxSize(content, maxBytes);
  const format = detectFormat(content, filename);
  if (!format) {
    throw new TrailPackError('parse_error', 'Formát souboru nebyl rozpoznán. Podporujeme GPX, KML a GeoJSON.');
  }
  const raw = format === 'gpx' ? fromGpx(content, maxBytes) : format === 'kml' ? fromKml(content, maxBytes) : fromGeoJson(content, maxBytes);
  const warnings = [...raw.warnings];

  const candidates = raw.lines.filter((l) => l.positions.length >= 2);
  if (candidates.length === 0) {
    throw new TrailPackError('parse_error', 'Soubor neobsahuje žádnou trasu (stopu nebo linii s alespoň dvěma body).');
  }
  const best = candidates.reduce((a, b) => (b.positions.length > a.positions.length ? b : a));
  if (candidates.length > 1) {
    warnings.push(`Soubor obsahuje ${candidates.length} tras, byla použita nejdelší (${best.positions.length.toLocaleString('cs-CZ')} bodů).`);
  }
  if (best.gaps > 0) {
    warnings.push(`Stopa se skládá z ${best.gaps + 1} úseků, které byly spojeny do jedné trasy.`);
  }

  let line = best.positions;
  const withEle = line.filter((p) => p.length > 2).length;
  const hasElevation = withEle > 0 && withEle >= line.length * 0.5;
  if (hasElevation && withEle < line.length) {
    warnings.push('Část bodů nemá nadmořskou výšku, chybějící hodnoty byly doplněny z nejbližšího předchozího bodu.');
    let last: number | undefined = line.find((p) => p.length > 2)?.[2];
    line = line.map((p): Position => {
      if (p.length > 2) {
        last = p[2];
        return p;
      }
      return [p[0], p[1], last ?? 0];
    });
  } else if (!hasElevation) {
    line = line.map((p): Position => [p[0], p[1]]);
    warnings.push('Soubor neobsahuje nadmořské výšky, převýšení nelze určit. Výšky lze doplnit z výškového modelu.');
  }

  const cum = cumulativeDistances(line);
  const distanceM = cum[cum.length - 1] ?? 0;
  // GPS-recorded tracks (with timestamps) are noisier than DEM-derived routes.
  const stats = hasElevation ? elevationStats(line, best.hasTime ? 5 : 3) : { ascentM: 0, descentM: 0 };

  const pointCount = line.length;
  let geometry = line;
  if (pointCount > maxPoints) {
    geometry = reduceLine(line, maxPoints);
    warnings.push(
      `Trasa měla ${pointCount.toLocaleString('cs-CZ')} bodů, byla zjednodušena na ${geometry.length.toLocaleString('cs-CZ')} bodů (vzdálenost a převýšení jsou spočteny z původních dat).`,
    );
  }

  return {
    name: best.name ?? raw.name ?? filename?.replace(/\.[^.]+$/, '') ?? 'Importovaná trasa',
    description: raw.description,
    geometry,
    waypoints: raw.waypoints,
    distanceM,
    ascentM: Math.round(stats.ascentM),
    descentM: Math.round(stats.descentM),
    hasElevation,
    hasTime: best.hasTime,
    pointCount,
    sourceFormat: format,
    warnings,
  };
}
