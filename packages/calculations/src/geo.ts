/**
 * Geodesy primitives. All functions are pure and work with GeoJSON order
 * positions `[lon, lat, ele?]` or `{lat, lon}` objects.
 *
 * STABLE API – other packages depend on these signatures.
 */
import type { BBox, LatLon, Position } from '@trailpack/shared';

export const EARTH_RADIUS_M = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in meters (haversine). */
export function haversine(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

export const posToLatLon = (p: Position): LatLon => ({ lat: p[1], lon: p[0] });
export const latLonToPos = (p: LatLon, ele?: number): Position => (ele === undefined ? [p.lon, p.lat] : [p.lon, p.lat, ele]);
export const eleOf = (p: Position): number | undefined => (p.length > 2 ? (p as [number, number, number])[2] : undefined);

/** Distance between two positions in meters (2D). */
export const positionDistance = (a: Position, b: Position): number => haversine(posToLatLon(a), posToLatLon(b));

/** Initial bearing from a to b in degrees (0 = north, clockwise). */
export function bearing(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point reached travelling `distanceM` from `start` on `bearingDeg`. */
export function destinationPoint(start: LatLon, bearingDeg: number, distanceM: number): LatLon {
  const δ = distanceM / EARTH_RADIUS_M;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(start.lat);
  const λ1 = toRad(start.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

/** Cumulative distance (m) at every vertex; result[0] = 0. */
export function cumulativeDistances(line: readonly Position[]): number[] {
  const out = new Array<number>(line.length);
  let acc = 0;
  for (let i = 0; i < line.length; i++) {
    if (i > 0) acc += positionDistance(line[i - 1]!, line[i]!);
    out[i] = acc;
  }
  return out;
}

/** Total 2D length of a line in meters. */
export function lineLength(line: readonly Position[]): number {
  let acc = 0;
  for (let i = 1; i < line.length; i++) acc += positionDistance(line[i - 1]!, line[i]!);
  return acc;
}

/** Bounding box [w, s, e, n] of positions. */
export function bboxOf(points: readonly (Position | LatLon)[]): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of points) {
    const lon = Array.isArray(p) ? p[0] : (p as LatLon).lon;
    const lat = Array.isArray(p) ? p[1] : (p as LatLon).lat;
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

/** Expand a bbox by `meters` in every direction. */
export function bufferBBox([w, s, e, n]: BBox, meters: number): BBox {
  const dLat = toDeg(meters / EARTH_RADIUS_M);
  const midLat = (s + n) / 2;
  const dLon = toDeg(meters / (EARTH_RADIUS_M * Math.max(0.01, Math.cos(toRad(midLat)))));
  return [Math.max(-180, w - dLon), Math.max(-90, s - dLat), Math.min(180, e + dLon), Math.min(90, n + dLat)];
}

export interface NearestPointResult {
  /** Snapped point on the line. */
  point: LatLon;
  /** Distance from the query point to the line (m). */
  distanceM: number;
  /** Index of the segment start vertex. */
  segmentIndex: number;
  /** Fraction along the segment 0..1 */
  t: number;
  /** Distance from line start to the snapped point (m). */
  alongM: number;
}

/**
 * Nearest point on a polyline (equirectangular projection per segment,
 * accurate to well under 1 m for hiking-scale segments).
 */
export function nearestPointOnLine(line: readonly Position[], p: LatLon, cumulative?: readonly number[]): NearestPointResult {
  if (line.length === 0) throw new Error('Empty line');
  const cum = cumulative ?? cumulativeDistances(line);
  if (line.length === 1) {
    const only = posToLatLon(line[0]!);
    return { point: only, distanceM: haversine(only, p), segmentIndex: 0, t: 0, alongM: 0 };
  }
  let best: NearestPointResult | null = null;
  const cosLat = Math.cos(toRad(p.lat));
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const ax = (a[0] - p.lon) * cosLat;
    const ay = a[1] - p.lat;
    const bx = (b[0] - p.lon) * cosLat;
    const by = b[1] - p.lat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const snapped = { lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t };
    const d = haversine(snapped, p);
    if (!best || d < best.distanceM) {
      const segLen = cum[i + 1]! - cum[i]!;
      best = { point: snapped, distanceM: d, segmentIndex: i, t, alongM: cum[i]! + segLen * t };
    }
  }
  return best!;
}

/** Point located `alongM` meters from the start of the line (interpolated, incl. elevation). */
export function pointAlong(line: readonly Position[], alongM: number, cumulative?: readonly number[]): { point: LatLon; ele?: number; index: number } {
  const cum = cumulative ?? cumulativeDistances(line);
  if (line.length === 0) throw new Error('Empty line');
  if (alongM <= 0) return { point: posToLatLon(line[0]!), ele: eleOf(line[0]!), index: 0 };
  const total = cum[cum.length - 1]!;
  if (alongM >= total) return { point: posToLatLon(line[line.length - 1]!), ele: eleOf(line[line.length - 1]!), index: line.length - 1 };
  // binary search for segment
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= alongM) lo = mid;
    else hi = mid;
  }
  const a = line[lo]!;
  const b = line[hi]!;
  const seg = cum[hi]! - cum[lo]!;
  const t = seg === 0 ? 0 : (alongM - cum[lo]!) / seg;
  const ea = eleOf(a);
  const eb = eleOf(b);
  return {
    point: { lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t },
    ele: ea !== undefined && eb !== undefined ? ea + (eb - ea) * t : (ea ?? eb),
    index: lo,
  };
}

/** Douglas–Peucker simplification with tolerance in meters (keeps elevation). */
export function simplifyLine(line: readonly Position[], toleranceM: number): Position[] {
  if (line.length <= 2) return [...line];
  const keep = new Uint8Array(line.length);
  keep[0] = 1;
  keep[line.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, line.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    const seg = [line[s]!, line[e]!];
    for (let i = s + 1; i < e; i++) {
      const d = nearestPointOnLine(seg, posToLatLon(line[i]!)).distanceM;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > toleranceM) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return line.filter((_, i) => keep[i] === 1);
}

/** Resample a line at a fixed spacing (m); always includes first and last vertex. */
export function resampleLine(line: readonly Position[], spacingM: number): Position[] {
  if (line.length < 2 || spacingM <= 0) return [...line];
  const cum = cumulativeDistances(line);
  const total = cum[cum.length - 1]!;
  const out: Position[] = [];
  for (let d = 0; d < total; d += spacingM) {
    const { point, ele } = pointAlong(line, d, cum);
    out.push(ele === undefined ? [point.lon, point.lat] : [point.lon, point.lat, ele]);
  }
  out.push(line[line.length - 1]!);
  return out;
}

/** Is the point inside the bbox? */
export const inBBox = (p: LatLon, [w, s, e, n]: BBox): boolean => p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n;
