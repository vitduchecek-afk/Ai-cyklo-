/**
 * Offline country detection from coarse border polygons (30-80 vertices per
 * country, [lon, lat], hand-simplified – accurate to roughly 5-10 km) plus an
 * online Nominatim reverse-geocoding variant.
 */
import { ENDPOINTS, buildUrl, type CountryCode, type HttpClient } from '@trailpack/shared';

type Ring = ReadonlyArray<readonly [number, number]>;

const RAW_POLYGONS: Record<string, Ring> = {
  CZ: [[12.09, 50.25], [12.55, 50.4], [12.95, 50.4], [13.4, 50.62], [13.95, 50.8], [14.25, 50.87], [14.3, 50.92], [14.55, 51.05], [14.82, 50.87], [15.0, 51.02], [15.3, 50.9], [15.55, 50.78], [15.85, 50.72], [16.2, 50.65], [16.55, 50.62], [16.65, 50.4], [16.85, 50.2], [17.2, 50.3], [17.6, 50.3], [17.75, 50.07], [18.05, 50.03], [18.35, 49.9], [18.6, 49.75], [18.85, 49.52], [18.6, 49.4], [18.3, 49.3], [18.05, 49.05], [17.55, 48.85], [17.16, 48.87], [16.95, 48.62], [16.5, 48.78], [16.1, 48.74], [15.75, 48.85], [15.35, 48.99], [14.95, 48.77], [14.6, 48.63], [14.3, 48.6], [13.83, 48.77], [13.45, 48.98], [13.2, 49.13], [12.85, 49.35], [12.5, 49.55], [12.45, 49.8]],
  SK: [[16.95, 48.62], [16.98, 48.35], [17.05, 48.12], [17.16, 48.0], [17.55, 47.86], [18.1, 47.75], [18.72, 47.8], [18.95, 48.06], [19.65, 48.23], [20.25, 48.28], [20.5, 48.55], [21.0, 48.55], [21.45, 48.52], [22.15, 48.4], [22.55, 49.08], [22.0, 49.2], [21.6, 49.4], [21.1, 49.42], [20.9, 49.3], [20.5, 49.4], [20.1, 49.2], [19.8, 49.3], [19.45, 49.6], [19.15, 49.53], [18.85, 49.52], [18.6, 49.4], [18.3, 49.3], [18.05, 49.05], [17.55, 48.85], [17.16, 48.87]],
  PL: [[14.82, 50.87], [15.0, 51.15], [14.72, 51.55], [14.73, 52.05], [14.55, 52.35], [14.2, 52.85], [14.3, 53.2], [14.2, 53.6], [14.25, 53.93], [14.9, 54.05], [15.58, 54.18], [16.4, 54.43], [16.85, 54.58], [17.55, 54.76], [18.3, 54.8], [18.8, 54.6], [18.6, 54.4], [19.45, 54.38], [19.8, 54.44], [20.45, 54.38], [21.5, 54.33], [22.8, 54.36], [23.5, 53.93], [23.9, 52.7], [23.6, 52.1], [23.55, 51.5], [23.9, 50.85], [24.1, 50.55], [23.55, 50.35], [22.95, 49.85], [22.65, 49.55], [22.55, 49.08], [22.0, 49.2], [21.6, 49.4], [21.1, 49.42], [20.9, 49.3], [20.5, 49.4], [20.1, 49.2], [19.8, 49.3], [19.45, 49.6], [19.15, 49.53], [18.85, 49.52], [18.6, 49.75], [18.35, 49.9], [18.05, 50.03], [17.75, 50.07], [17.6, 50.3], [17.2, 50.3], [16.85, 50.2], [16.65, 50.4], [16.55, 50.62], [16.2, 50.65], [15.85, 50.72], [15.55, 50.78], [15.3, 50.9], [15.0, 51.02]],
  AT: [[13.83, 48.77], [13.45, 48.57], [13.03, 48.26], [13.0, 47.85], [12.78, 47.65], [12.17, 47.62], [11.4, 47.52], [10.98, 47.42], [10.45, 47.55], [10.2, 47.28], [9.8, 47.55], [9.55, 47.52], [9.53, 47.05], [10.1, 46.85], [10.45, 46.85], [10.9, 46.77], [11.5, 46.99], [12.2, 47.08], [12.4, 46.75], [12.7, 46.65], [13.7, 46.52], [14.5, 46.42], [15.0, 46.65], [15.65, 46.7], [16.1, 46.87], [16.45, 47.4], [16.5, 47.65], [17.1, 47.7], [17.16, 48.0], [17.05, 48.12], [16.98, 48.35], [16.95, 48.62], [16.5, 48.78], [16.1, 48.74], [15.75, 48.85], [15.35, 48.99], [14.95, 48.77], [14.6, 48.63], [14.3, 48.6]],
  DE: [[14.82, 50.87], [15.0, 51.15], [14.72, 51.55], [14.73, 52.05], [14.55, 52.35], [14.2, 52.85], [14.3, 53.2], [14.2, 53.6], [14.25, 53.93], [13.7, 54.5], [12.5, 54.45], [11.1, 54.0], [10.8, 54.35], [10.2, 54.5], [9.8, 54.82], [9.4, 54.85], [8.65, 54.9], [8.6, 54.5], [8.85, 54.05], [8.1, 53.65], [7.4, 53.4], [7.2, 53.3], [7.05, 52.65], [6.95, 52.45], [6.7, 52.05], [6.05, 51.85], [6.1, 51.2], [6.0, 50.8], [6.4, 50.3], [6.5, 50.0], [6.35, 49.45], [6.7, 49.2], [7.4, 49.12], [8.2, 48.98], [7.8, 48.6], [7.6, 47.85], [7.6, 47.58], [8.1, 47.58], [8.6, 47.65], [8.7, 47.75], [9.17, 47.67], [9.55, 47.53], [9.8, 47.55], [10.2, 47.28], [10.45, 47.55], [10.98, 47.42], [11.4, 47.52], [12.17, 47.62], [12.78, 47.65], [13.1, 47.55], [13.0, 47.85], [13.03, 48.26], [13.45, 48.57], [13.83, 48.77], [13.45, 48.98], [13.2, 49.13], [12.85, 49.35], [12.5, 49.55], [12.45, 49.8], [12.09, 50.25], [12.55, 50.4], [12.95, 50.4], [13.4, 50.62], [13.95, 50.8], [14.25, 50.87], [14.3, 50.92], [14.55, 51.05]],
  CH: [[7.58, 47.58], [8.1, 47.58], [8.6, 47.65], [8.7, 47.75], [9.17, 47.67], [9.55, 47.53], [9.53, 47.05], [10.1, 46.85], [10.47, 46.85], [10.45, 46.55], [10.1, 46.25], [9.3, 46.5], [9.15, 46.15], [9.03, 45.83], [8.7, 46.0], [8.3, 46.1], [7.9, 46.05], [7.75, 45.95], [7.15, 45.9], [6.87, 46.05], [6.8, 46.4], [6.1, 46.2], [5.96, 46.13], [6.1, 46.45], [6.45, 46.6], [6.7, 47.05], [6.95, 47.3], [7.0, 47.5]],
  HU: [[16.1, 46.87], [16.45, 47.4], [16.5, 47.65], [17.1, 47.7], [17.16, 48.0], [17.55, 47.86], [18.1, 47.75], [18.72, 47.8], [18.95, 48.06], [19.65, 48.23], [20.25, 48.28], [20.5, 48.55], [21.0, 48.55], [21.45, 48.52], [22.15, 48.4], [22.45, 48.25], [22.9, 47.95], [22.0, 47.5], [21.55, 46.95], [21.3, 46.65], [21.05, 46.28], [20.25, 46.12], [19.6, 46.17], [19.1, 45.95], [18.85, 45.92], [18.0, 45.8], [17.45, 45.85], [16.9, 46.35], [16.6, 46.47]],
  SI: [[13.72, 46.52], [14.5, 46.42], [15.0, 46.65], [15.65, 46.7], [16.1, 46.87], [16.6, 46.47], [16.25, 46.38], [15.75, 46.2], [15.65, 45.85], [15.35, 45.45], [14.6, 45.55], [14.25, 45.5], [13.9, 45.45], [13.6, 45.52], [13.6, 45.8], [13.5, 46.0], [13.65, 46.2]],
};

/** Insert midpoints on the longest edges until the ring has at least `min` vertices (does not change the shape). */
function densify(ring: Ring, min: number): Ring {
  const out: Array<readonly [number, number]> = ring.map((p) => [p[0], p[1]] as const);
  while (out.length < min) {
    let bi = 0;
    let bl = -1;
    for (let i = 0; i < out.length; i++) {
      const a = out[i]!;
      const b = out[(i + 1) % out.length]!;
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l > bl) {
        bl = l;
        bi = i;
      }
    }
    const a = out[bi]!;
    const b = out[(bi + 1) % out.length]!;
    out.splice(bi + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const);
  }
  return out;
}

/** Coarse country outlines, [lon, lat], 30-80 vertices each. */
export const COUNTRY_POLYGONS: Record<string, Ring> = Object.fromEntries(Object.entries(RAW_POLYGONS).map(([k, v]) => [k, densify(v, 30)]));

/** Distance (km) from a border within which the result is only 'low' confidence. */
export const BORDER_LOW_CONFIDENCE_KM = 15;

export interface CountryDetection {
  /** ISO code or null when the point lies in none of the supported countries. */
  countryCode: CountryCode | null;
  /** 'high' = clearly inside; 'low' = within ~15 km of a border (or only near a polygon); 'none' = unknown. */
  confidence: 'high' | 'low' | 'none';
  /** Distance to the nearest border edge of the matched polygon (km), if known. */
  borderDistanceKm?: number;
  source: 'offline-polygon' | 'nominatim';
}

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance (km) from a point to the nearest edge of a ring (equirectangular approximation). */
function edgeDistanceKm(lon: number, lat: number, ring: Ring): number {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ky = 110.57;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j]![0] * kx;
    const ay = ring[j]![1] * ky;
    const bx = ring[i]![0] * kx;
    const by = ring[i]![1] * ky;
    const px = lon * kx;
    const py = lat * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

/** Detect the country without network access. Points near a border get 'low' confidence. */
export function detectCountryOffline(lat: number, lon: number): CountryDetection {
  let hit: { code: string; dist: number } | undefined;
  for (const [code, ring] of Object.entries(COUNTRY_POLYGONS)) {
    if (inRing(lon, lat, ring)) {
      const dist = edgeDistanceKm(lon, lat, ring);
      if (!hit || dist > hit.dist) hit = { code, dist }; // overlapping coarse borders: prefer the deeper match
    }
  }
  if (hit) {
    return { countryCode: hit.code, confidence: hit.dist <= BORDER_LOW_CONFIDENCE_KM ? 'low' : 'high', borderDistanceKm: Math.round(hit.dist * 10) / 10, source: 'offline-polygon' };
  }
  // outside every polygon: close to one (coarse polygons / sea coast) -> low-confidence nearest
  let near: { code: string; dist: number } | undefined;
  for (const [code, ring] of Object.entries(COUNTRY_POLYGONS)) {
    const dist = edgeDistanceKm(lon, lat, ring);
    if (!near || dist < near.dist) near = { code, dist };
  }
  if (near && near.dist <= BORDER_LOW_CONFIDENCE_KM) return { countryCode: near.code, confidence: 'low', borderDistanceKm: Math.round(near.dist * 10) / 10, source: 'offline-polygon' };
  return { countryCode: null, confidence: 'none', source: 'offline-polygon' };
}

/** Detect the country via Nominatim reverse geocoding (`address.country_code`). Throws TrailPackError on failure. */
export async function detectCountryOnline(http: HttpClient, lat: number, lon: number): Promise<CountryDetection> {
  const url = buildUrl(`${ENDPOINTS.nominatim}/reverse`, { format: 'jsonv2', lat, lon, zoom: 3, addressdetails: 1, 'accept-language': 'en' });
  const body = await http.json<{ address?: { country_code?: string } }>(url, { provider: 'nominatim' });
  const cc = body.address?.country_code;
  if (typeof cc !== 'string' || !/^[a-z]{2}$/i.test(cc)) return { countryCode: null, confidence: 'none', source: 'nominatim' };
  return { countryCode: cc.toUpperCase(), confidence: 'high', source: 'nominatim' };
}
