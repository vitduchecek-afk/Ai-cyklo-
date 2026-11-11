/**
 * Elevation lookup (Open-Meteo, Copernicus DEM ≈ 90 m, free, no key).
 *
 * API: GET https://api.open-meteo.com/v1/elevation?latitude=a,b,…&longitude=c,d,… (max 100 coordinates per request)
 * → `{ "elevation": [m, …] }`.
 */
import type { KeyValueCache, LatLon, Position } from '@trailpack/shared';
import { ENDPOINTS, HttpClient, TrailPackError, buildUrl, cacheKey, cached } from '@trailpack/shared';
import { cumulativeDistances } from '@trailpack/calculations';

const MAX_PER_REQUEST = 100;
const TTL_MS = 30 * 24 * 3600 * 1000;

export interface ElevationServiceOptions {
  http: HttpClient;
  cache?: KeyValueCache;
  /** Override for tests. */
  baseUrl?: string;
}

export interface EnrichOptions {
  /** Upper bound of DEM lookups per geometry (default 300). */
  maxSamples?: number;
  signal?: AbortSignal;
}

export class ElevationService {
  private readonly http: HttpClient;
  private readonly cache?: KeyValueCache;
  private readonly baseUrl: string;

  constructor(opts: ElevationServiceOptions) {
    this.http = opts.http;
    this.cache = opts.cache;
    this.baseUrl = opts.baseUrl ?? ENDPOINTS.openMeteoElevation;
  }

  /**
   * Elevations (meters) for arbitrary coordinates, batched by 100 and cached per batch.
   * @throws TrailPackError `parse_error` when the response does not match the request.
   */
  async lookup(points: readonly LatLon[], signal?: AbortSignal): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < points.length; i += MAX_PER_REQUEST) {
      const batch = points.slice(i, i + MAX_PER_REQUEST);
      const lat = batch.map((p) => p.lat.toFixed(5));
      const lon = batch.map((p) => p.lon.toFixed(5));
      const { value } = await cached(this.cache, cacheKey('elev', { lat, lon }), TTL_MS, async () => {
        const res = await this.http.json<{ elevation?: Array<number | null> }>(buildUrl(this.baseUrl, { latitude: lat.join(','), longitude: lon.join(',') }), {
          provider: 'open-meteo',
          signal,
        });
        if (!Array.isArray(res.elevation) || res.elevation.length !== batch.length) {
          throw new TrailPackError('parse_error', 'Služba pro nadmořské výšky vrátila neočekávanou odpověď.', { provider: 'open-meteo' });
        }
        return res.elevation.map((e) => (typeof e === 'number' && Number.isFinite(e) ? e : Number.NaN));
      });
      out.push(...value);
    }
    return out;
  }

  /**
   * Adds elevation to a 2D geometry: DEM lookups at ≤ `maxSamples` evenly spaced
   * vertices, linear interpolation along the line for the rest. Geometries that
   * already have elevation on every vertex are returned unchanged.
   */
  async enrich(geometry: readonly Position[], opts: EnrichOptions = {}): Promise<Position[]> {
    if (geometry.length === 0 || geometry.every((p) => p.length > 2)) return [...geometry];
    const maxSamples = Math.max(2, Math.min(opts.maxSamples ?? 300, 2000));
    const cum = cumulativeDistances(geometry);
    const total = cum[cum.length - 1] ?? 0;
    // choose sample vertex indices
    let idx: number[];
    if (geometry.length <= maxSamples) idx = geometry.map((_, i) => i);
    else {
      const set = new Set<number>([0, geometry.length - 1]);
      let j = 0;
      for (let k = 1; k < maxSamples - 1; k++) {
        const target = (total * k) / (maxSamples - 1);
        while (j < cum.length - 1 && (cum[j] ?? 0) < target) j++;
        set.add(j);
      }
      idx = [...set].sort((a, b) => a - b);
    }
    const elev = await this.lookup(
      idx.map((i) => ({ lon: geometry[i]![0], lat: geometry[i]![1] })),
      opts.signal,
    );
    // known (distance, elevation) pairs, dropping NaN
    const xs: number[] = [];
    const ys: number[] = [];
    idx.forEach((vi, k) => {
      const e = elev[k];
      if (e !== undefined && Number.isFinite(e)) {
        xs.push(cum[vi] ?? 0);
        ys.push(e);
      }
    });
    if (xs.length === 0) throw new TrailPackError('provider_error', 'Pro tuto oblast nejsou k dispozici nadmořské výšky.', { provider: 'open-meteo' });
    const out: Position[] = [];
    let k = 0;
    for (let i = 0; i < geometry.length; i++) {
      const d = cum[i] ?? 0;
      while (k < xs.length - 2 && xs[k + 1]! < d) k++;
      let e: number;
      if (xs.length === 1 || d <= xs[0]!) e = ys[0]!;
      else if (d >= xs[xs.length - 1]!) e = ys[ys.length - 1]!;
      else {
        const x0 = xs[k]!;
        const x1 = xs[k + 1]!;
        e = x1 > x0 ? ys[k]! + ((ys[k + 1]! - ys[k]!) * (d - x0)) / (x1 - x0) : ys[k]!;
      }
      const p = geometry[i]!;
      out.push([p[0], p[1], Math.round(e * 10) / 10]);
    }
    return out;
  }
}
