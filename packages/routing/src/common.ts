/**
 * Helpers shared by the routing adapters: surface normalisation, segment
 * building, polyline decoding, error mapping, avoid-area geometry.
 */
import type { ActivityType, LatLon, Position, RouteSegment } from '@trailpack/shared';
import { TrailPackError, isCyclingActivity } from '@trailpack/shared';
import { destinationPoint, elevationStatsRange, cumulativeDistances } from '@trailpack/calculations';
import type { RoutingRequest } from './types';

export const SURFACE_CATEGORIES = ['paved', 'paving_stones', 'gravel', 'ground', 'rock', 'unknown'] as const;
export type SurfaceCategory = (typeof SURFACE_CATEGORIES)[number];

const SURFACE_MAP: Record<string, SurfaceCategory> = {
  asphalt: 'paved',
  paved: 'paved',
  concrete: 'paved',
  'concrete:plates': 'paved',
  'concrete:lanes': 'paved',
  metal: 'paved',
  wood: 'paved',
  bricks: 'paving_stones',
  paving_stones: 'paving_stones',
  sett: 'paving_stones',
  cobblestone: 'paving_stones',
  unhewn_cobblestone: 'paving_stones',
  compacted: 'gravel',
  fine_gravel: 'gravel',
  gravel: 'gravel',
  pebblestone: 'gravel',
  paved_rough: 'gravel',
  unpaved: 'ground',
  ground: 'ground',
  dirt: 'ground',
  earth: 'ground',
  mud: 'ground',
  grass: 'ground',
  grass_paver: 'ground',
  sand: 'ground',
  woodchips: 'ground',
  clay: 'ground',
  snow: 'ground',
  ice: 'ground',
  path: 'ground',
  rock: 'rock',
  stone: 'rock',
};

/** Maps an OSM `surface` value (or a Valhalla/ORS surface name) to a coarse category. */
export function normalizeSurface(surface: string | undefined): SurfaceCategory {
  if (!surface) return 'unknown';
  return SURFACE_MAP[surface.trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? 'unknown';
}

/** Parses BRouter style `key=value key=value` tag strings. */
export function parseTagString(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(/\s+/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

export interface SegmentRun {
  fromIdx: number;
  toIdx: number;
  /** Raw OSM-like surface value. */
  surface?: string;
  wayType?: string;
}

/**
 * Builds `RouteSegment`s for runs of geometry indices, computing distance and
 * ascent/descent from the geometry. Runs must be non-empty and ordered.
 */
export function buildSegments(geometry: readonly Position[], runs: readonly SegmentRun[]): RouteSegment[] {
  const cum = cumulativeDistances(geometry);
  const last = geometry.length - 1;
  const out: RouteSegment[] = [];
  for (const r of runs) {
    const from = Math.max(0, Math.min(last, r.fromIdx));
    const to = Math.max(from, Math.min(last, r.toIdx));
    if (to === from) continue;
    const stats = elevationStatsRange(geometry, from, to, 1);
    const distanceM = (cum[to] ?? 0) - (cum[from] ?? 0);
    const seg: RouteSegment = {
      index: out.length,
      fromIdx: from,
      toIdx: to,
      distanceM,
      ascentM: Math.round(stats.ascentM),
      descentM: Math.round(stats.descentM),
    };
    if (r.surface) seg.surface = r.surface;
    if (r.wayType) seg.wayType = r.wayType;
    if (distanceM > 0 && stats.startEleM !== undefined && stats.endEleM !== undefined) {
      seg.gradePct = Math.round(((stats.endEleM - stats.startEleM) / distanceM) * 1000) / 10;
    }
    out.push(seg);
  }
  return out;
}

/** Merges neighbouring runs with the same surface and way type. */
export function mergeRuns(runs: readonly SegmentRun[]): SegmentRun[] {
  const out: SegmentRun[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (prev && prev.surface === r.surface && prev.wayType === r.wayType && prev.toIdx === r.fromIdx) prev.toIdx = r.toIdx;
    else out.push({ ...r });
  }
  return out;
}

/** Meters per normalised surface category over all segments. */
export function summarizeSurfaces(segments: readonly RouteSegment[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of segments) {
    const k = normalizeSurface(s.surface);
    out[k] = Math.round(((out[k] ?? 0) + s.distanceM) * 10) / 10;
  }
  return out;
}

/** Decodes an encoded polyline (Google algorithm) with the given precision (5 or 6) into `[lon, lat]` positions. */
export function decodePolyline(encoded: string, precision = 6): Position[] {
  const factor = 10 ** precision;
  const out: Position[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1] as const) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        if (index >= encoded.length) throw new TrailPackError('parse_error', 'Neplatná kódovaná geometrie trasy.');
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    out.push([lon / factor, lat / factor]);
  }
  return out;
}

/** Closed polygon ring approximating a circle (for providers that only take polygons). Coordinates `[lon, lat]`. */
export function circleRing(center: LatLon, radiusM: number, sides = 16): Array<[number, number]> {
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < sides; i++) {
    const p = destinationPoint(center, (360 * i) / sides, radiusM);
    ring.push([Math.round(p.lon * 1e6) / 1e6, Math.round(p.lat * 1e6) / 1e6]);
  }
  ring.push(ring[0]!);
  return ring;
}

export const isHikingActivity = (a: ActivityType): boolean => !isCyclingActivity(a);

/** Czech message for a provider's raw "no route" text. */
export const NO_ROUTE_MESSAGE = 'Mezi zadanými body se nepodařilo najít trasu. Zkuste posunout body blíže k cestě nebo zvolit jiný typ trasy.';

/**
 * Converts a low-level error to a `no_route` error when the provider body
 * indicates that routing was impossible. Other errors are returned unchanged.
 */
export function mapRoutingError(e: unknown, provider: string, noRoutePattern: RegExp): TrailPackError {
  if (e instanceof TrailPackError) {
    const text = `${e.message} ${typeof e.details === 'string' ? e.details : ''}`;
    if ((e.status === 400 || e.status === 404 || e.status === 500 || e.status === undefined) && e.code !== 'network' && noRoutePattern.test(text)) {
      return new TrailPackError('no_route', NO_ROUTE_MESSAGE, { provider, status: e.status, cause: e, details: e.details });
    }
    return e;
  }
  return new TrailPackError('unknown', e instanceof Error ? e.message : String(e), { provider, cause: e });
}

/** Requires an API key; throws `not_configured` with a Czech message otherwise. */
export function requireKey(key: string | undefined, provider: string, label: string): string {
  if (!key || !key.trim()) {
    throw new TrailPackError('not_configured', `Pro ${label} je potřeba API klíč. Přidejte ho v Nastavení → Mapové služby.`, { provider });
  }
  return key.trim();
}

/** Throws a Czech `invalid_input` error when a request cannot be served (e.g. round trip with several points). */
export function assertWaypoints(req: RoutingRequest, provider: string): void {
  if (req.waypoints.length < 2 && !req.roundTrip) {
    throw new TrailPackError('invalid_input', 'Trasa potřebuje alespoň dva body.', { provider });
  }
}

/** Fills elevation-free geometry flag. */
export const hasElevation = (geometry: readonly Position[]): boolean => geometry.length > 0 && geometry.every((p) => p.length > 2);

/** Parses a finite number or returns undefined. */
export function finite(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}
