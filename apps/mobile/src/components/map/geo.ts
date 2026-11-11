/** Pure geo helpers for the map layer (no React / RN imports). */

export const EARTH_RADIUS_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export type LonLat = [number, number];

/** Great-circle distance in metres between two [lon, lat] points. */
export function haversine(a: LonLat, b: LonLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function pathLength(points: readonly LonLat[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += haversine(points[i - 1] as LonLat, points[i] as LonLat);
  return sum;
}

/** `50.07554° N, 14.43780° E` */
export function formatCoords(lat: number, lon: number, digits = 5): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(digits)}° ${ns}, ${Math.abs(lon).toFixed(digits)}° ${ew}`;
}

/** `50.07554, 14.43780` – what you paste into other map apps. */
export function formatCoordsPlain(lat: number, lon: number, digits = 5): string {
  return `${lat.toFixed(digits)}, ${lon.toFixed(digits)}`;
}

/** [west, south, east, north] of all positions, or null if empty. */
export function bboxOf(points: readonly LonLat[]): [number, number, number, number] | null {
  if (points.length === 0) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

/** Collect [lon, lat] positions from a (Multi)LineString / Point GeoJSON FeatureCollection. */
export function collectPositions(fc: { features: { geometry: { type: string; coordinates: unknown } }[] } | undefined): LonLat[] {
  const out: LonLat[] = [];
  const walk = (c: unknown) => {
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') out.push([c[0], c[1]]);
    else if (Array.isArray(c)) c.forEach(walk);
  };
  fc?.features.forEach((f) => walk(f.geometry.coordinates));
  return out;
}

/** Human distance for the measure tool. */
export function formatMeasure(meters: number, units: 'metric' | 'imperial' = 'metric', locale = 'cs-CZ'): string {
  if (units === 'imperial') {
    const mi = meters / 1609.344;
    return mi < 0.1 ? `${Math.round(meters * 3.28084)} ft` : `${mi.toLocaleString(locale, { maximumFractionDigits: 2 })} mi`;
  }
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km.toLocaleString(locale, { maximumFractionDigits: km < 100 ? 2 : 1 })} km`;
}

/** Normalise a bearing into 0..360. */
export const normBearing = (b: number) => ((b % 360) + 360) % 360;
