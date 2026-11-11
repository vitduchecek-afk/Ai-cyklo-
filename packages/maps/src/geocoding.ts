/**
 * Geocoding: Photon (autocomplete + reverse, komoot), Nominatim (search +
 * reverse only – never autocomplete, max 1 request/s, per OSMF usage policy) and
 * Mapy.com (key). `GeocodingService` combines them with typed-coordinate
 * parsing, caching and AbortSignal support.
 */
import { z } from 'zod';
import type { BBox, GeocoderProviderId, KeyValueCache } from '@trailpack/shared';
import { ENDPOINTS, HttpClient, TrailPackError, buildUrl, cacheKey, cached, parseCoordinates } from '@trailpack/shared';

export type GeocodingKind = 'coordinates' | 'country' | 'region' | 'city' | 'village' | 'street' | 'address' | 'peak' | 'water' | 'poi' | 'other';

export interface GeocodingResult {
  /** Stable id such as `photon:N123`, `nominatim:node/123`, `mapy:…`. */
  id: string;
  name: string;
  /** Single-line label for lists, e.g. "Sněžka, Malá Úpa, Česko". */
  label: string;
  lat: number;
  lon: number;
  kind: GeocodingKind;
  country?: string;
  /** ISO 3166-1 alpha-2, upper case. */
  countryCode?: string;
  region?: string;
  /** [west, south, east, north] */
  bbox?: BBox;
  source: GeocoderProviderId | 'coordinates';
}

export interface GeocodeOptions {
  signal?: AbortSignal;
  /** Maximum results (default 8). */
  limit?: number;
  /** Result language (default 'cs'). */
  lang?: string;
  /** Bias results towards this location (Photon / Mapy). */
  near?: { lat: number; lon: number };
  /** ISO country codes to restrict to (Nominatim). */
  countryCodes?: string[];
}

const dedupe = (parts: Array<string | undefined>): string[] => {
  const out: string[] = [];
  for (const p of parts) if (p && !out.includes(p)) out.push(p);
  return out;
};

const isBBox = (b: number[]): b is BBox => b.length === 4 && b.every(Number.isFinite) && b[0]! <= b[2]! && b[1]! <= b[3]!;

/** Classifies an OSM key/value pair. */
export function kindFromOsm(key?: string, value?: string): GeocodingKind {
  switch (key) {
    case 'place':
      if (value === 'country') return 'country';
      if (['state', 'region', 'province', 'county', 'district', 'municipality'].includes(value ?? '')) return 'region';
      if (['city', 'town', 'borough', 'suburb'].includes(value ?? '')) return 'city';
      if (['village', 'hamlet', 'isolated_dwelling', 'locality', 'neighbourhood', 'quarter', 'farm'].includes(value ?? '')) return 'village';
      return 'other';
    case 'boundary':
      return value === 'administrative' ? 'region' : 'other';
    case 'highway':
      return ['bus_stop', 'platform', 'trailhead', 'rest_area', 'services'].includes(value ?? '') ? 'poi' : 'street';
    case 'building':
      return 'address';
    case 'natural':
      if (value === 'peak' || value === 'volcano' || value === 'saddle' || value === 'hill') return 'peak';
      if (['water', 'spring', 'bay', 'strait', 'glacier'].includes(value ?? '')) return 'water';
      return 'poi';
    case 'waterway':
      return 'water';
    case undefined:
      return 'other';
    default:
      return 'poi';
  }
}

// ---------------------------------------------------------------------------
// Photon
// ---------------------------------------------------------------------------

const PhotonFeatureSchema = z.object({
  geometry: z.object({ coordinates: z.tuple([z.number(), z.number()]).rest(z.number()) }),
  properties: z
    .object({
      osm_type: z.string().optional(),
      osm_id: z.number().optional(),
      osm_key: z.string().optional(),
      osm_value: z.string().optional(),
      name: z.string().optional(),
      street: z.string().optional(),
      housenumber: z.string().optional(),
      district: z.string().optional(),
      locality: z.string().optional(),
      city: z.string().optional(),
      county: z.string().optional(),
      state: z.string().optional(),
      country: z.string().optional(),
      countrycode: z.string().optional(),
      /** [minLon, maxLat, maxLon, minLat] */
      extent: z.array(z.number()).optional(),
    })
    .passthrough(),
});
const PhotonResponseSchema = z.object({ features: z.array(PhotonFeatureSchema) });

/** Converts one Photon feature (exported for tests). */
export function photonFeatureToResult(f: z.infer<typeof PhotonFeatureSchema>): GeocodingResult | null {
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const hasAddress = !!p.housenumber;
  const street = p.street ? `${p.street}${p.housenumber ? ` ${p.housenumber}` : ''}` : undefined;
  const name = p.name ?? street ?? p.city ?? p.state ?? p.country;
  if (!name) return null;
  const kind = hasAddress && !p.osm_key?.match(/^(amenity|tourism|shop|natural|leisure)$/) ? 'address' : kindFromOsm(p.osm_key, p.osm_value);
  const place = p.city ?? p.locality ?? p.district ?? p.county;
  const label = dedupe([name, p.name ? street : undefined, place, p.state && kind !== 'region' ? undefined : p.state, p.country]).join(', ');
  const bbox: BBox | undefined = p.extent && p.extent.length === 4 ? ([p.extent[0]!, p.extent[3]!, p.extent[2]!, p.extent[1]!] as BBox) : undefined;
  return {
    id: `photon:${p.osm_type ?? '?'}${p.osm_id ?? `${lat},${lon}`}`,
    name,
    label,
    lat,
    lon,
    kind,
    country: p.country,
    countryCode: p.countrycode?.toUpperCase(),
    region: p.state ?? p.county,
    bbox: bbox && isBBox(bbox) ? bbox : undefined,
    source: 'photon',
  };
}

/** Photon supports only a few result languages; others (cs, sk, pl) get local names. */
const PHOTON_LANGS = new Set(['en', 'de', 'fr', 'it']);

export class PhotonGeocoder {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string = ENDPOINTS.photon,
  ) {}

  /** Autocomplete / search. Call debounced (≥ 250 ms) from the UI. */
  async search(query: string, o: GeocodeOptions = {}): Promise<GeocodingResult[]> {
    const lang = o.lang && PHOTON_LANGS.has(o.lang) ? o.lang : undefined;
    const url = buildUrl(`${this.baseUrl}/api/`, { q: query, limit: o.limit ?? 8, lang, lat: o.near?.lat, lon: o.near?.lon });
    return this.parse(await this.http.json(url, { provider: 'photon', signal: o.signal }));
  }

  async reverse(lat: number, lon: number, o: GeocodeOptions = {}): Promise<GeocodingResult | null> {
    const lang = o.lang && PHOTON_LANGS.has(o.lang) ? o.lang : undefined;
    const url = buildUrl(`${this.baseUrl}/reverse`, { lat, lon, limit: 1, lang });
    return this.parse(await this.http.json(url, { provider: 'photon', signal: o.signal }))[0] ?? null;
  }

  private parse(raw: unknown): GeocodingResult[] {
    const parsed = PhotonResponseSchema.safeParse(raw);
    if (!parsed.success) throw new TrailPackError('parse_error', 'Odpověď Photon má neočekávaný formát.', { provider: 'photon', details: parsed.error.issues.slice(0, 3) });
    return parsed.data.features.map(photonFeatureToResult).filter((r): r is GeocodingResult => r !== null);
  }
}

// ---------------------------------------------------------------------------
// Nominatim
// ---------------------------------------------------------------------------

const NominatimItemSchema = z
  .object({
    osm_type: z.string().optional(),
    osm_id: z.number().optional(),
    lat: z.union([z.string(), z.number()]),
    lon: z.union([z.string(), z.number()]),
    category: z.string().optional(),
    type: z.string().optional(),
    name: z.string().optional(),
    display_name: z.string().optional(),
    address: z.record(z.string(), z.string()).optional(),
    boundingbox: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .passthrough();

/** Converts one Nominatim item (exported for tests). */
export function nominatimItemToResult(it: z.infer<typeof NominatimItemSchema>): GeocodingResult | null {
  const lat = Number(it.lat);
  const lon = Number(it.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const a = it.address ?? {};
  const name = it.name || a[it.type ?? ''] || it.display_name?.split(',')[0]?.trim();
  if (!name) return null;
  const place = a.city ?? a.town ?? a.village ?? a.hamlet ?? a.municipality ?? a.county;
  const road = a.road ? `${a.road}${a.house_number ? ` ${a.house_number}` : ''}` : undefined;
  const isAddress = it.category === 'building' || it.category === 'place' && it.type === 'house' || (!!a.house_number && it.category !== 'natural');
  const kind: GeocodingKind = isAddress ? 'address' : it.category === 'boundary' && it.type === 'administrative' ? (it.addresstype === 'country' ? 'country' : it.addresstype === 'city' || it.addresstype === 'town' ? 'city' : it.addresstype === 'village' ? 'village' : 'region') : kindFromOsm(it.category, it.type);
  const bb = it.boundingbox?.map(Number);
  // Nominatim order: [south, north, west, east]
  const bbox: BBox | undefined = bb && bb.length === 4 ? ([bb[2]!, bb[0]!, bb[3]!, bb[1]!] as BBox) : undefined;
  return {
    id: `nominatim:${it.osm_type ?? '?'}/${it.osm_id ?? `${lat},${lon}`}`,
    name,
    label: dedupe([name, name === road ? undefined : road, place === name ? undefined : place, a.country]).join(', '),
    lat,
    lon,
    kind,
    country: a.country,
    countryCode: a.country_code?.toUpperCase(),
    region: a.state ?? a.region ?? a.county,
    bbox: bbox && isBBox(bbox) ? bbox : undefined,
    source: 'nominatim',
  };
}

export interface NominatimOptions {
  baseUrl?: string;
  /** Minimum gap between requests of this instance (default 1100 ms, the policy is 1 request/second). */
  minIntervalMs?: number;
}

/**
 * Nominatim client. It deliberately offers no `autocomplete`: the public
 * instance forbids search-as-you-type. Use only for explicit searches / reverse lookups.
 */
export class NominatimGeocoder {
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private chain: Promise<void> = Promise.resolve();
  private last = 0;

  constructor(
    private readonly http: HttpClient,
    opts: NominatimOptions = {},
  ) {
    this.baseUrl = opts.baseUrl ?? ENDPOINTS.nominatim;
    this.minIntervalMs = opts.minIntervalMs ?? 1100;
  }

  /** Waits so that consecutive calls of this instance are ≥ minIntervalMs apart. */
  private async gate(signal?: AbortSignal): Promise<void> {
    const run = this.chain.then(async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) {
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(new TrailPackError('aborted', 'Request aborted'));
          const t = setTimeout(resolve, wait);
          signal?.addEventListener('abort', () => { clearTimeout(t); reject(new TrailPackError('aborted', 'Request aborted')); }, { once: true });
        });
      }
      this.last = Date.now();
    });
    this.chain = run.catch(() => undefined);
    await run;
  }

  /** Explicit (submitted) search. */
  async search(query: string, o: GeocodeOptions = {}): Promise<GeocodingResult[]> {
    await this.gate(o.signal);
    const url = buildUrl(`${this.baseUrl}/search`, {
      q: query,
      format: 'jsonv2',
      addressdetails: 1,
      limit: o.limit ?? 8,
      'accept-language': o.lang ?? 'cs',
      countrycodes: o.countryCodes?.map((c) => c.toLowerCase()).join(','),
    });
    const raw = await this.http.json(url, { provider: 'nominatim', signal: o.signal });
    const parsed = z.array(NominatimItemSchema).safeParse(raw);
    if (!parsed.success) throw new TrailPackError('parse_error', 'Odpověď Nominatim má neočekávaný formát.', { provider: 'nominatim', details: parsed.error.issues.slice(0, 3) });
    return parsed.data.map(nominatimItemToResult).filter((r): r is GeocodingResult => r !== null);
  }

  async reverse(lat: number, lon: number, o: GeocodeOptions & { zoom?: number } = {}): Promise<GeocodingResult | null> {
    await this.gate(o.signal);
    const url = buildUrl(`${this.baseUrl}/reverse`, { lat, lon, format: 'jsonv2', addressdetails: 1, zoom: o.zoom ?? 18, 'accept-language': o.lang ?? 'cs' });
    const raw = (await this.http.json(url, { provider: 'nominatim', signal: o.signal })) as { error?: string };
    if (raw && typeof raw === 'object' && 'error' in raw) return null;
    const parsed = NominatimItemSchema.safeParse(raw);
    if (!parsed.success) throw new TrailPackError('parse_error', 'Odpověď Nominatim má neočekávaný formát.', { provider: 'nominatim', details: parsed.error.issues.slice(0, 3) });
    return nominatimItemToResult(parsed.data);
  }
}

// ---------------------------------------------------------------------------
// Mapy.com
// ---------------------------------------------------------------------------

const MapyItemSchema = z
  .object({
    name: z.string(),
    label: z.string().optional(),
    position: z.object({ lat: z.number(), lon: z.number() }),
    type: z.string().optional(),
    location: z.string().optional(),
    zip: z.string().optional(),
    bbox: z.array(z.number()).optional(),
    regionalStructure: z.array(z.object({ name: z.string(), type: z.string() }).passthrough()).optional(),
  })
  .passthrough();
const MapyResponseSchema = z.object({ items: z.array(MapyItemSchema) });

function mapyKind(type?: string): GeocodingKind {
  if (!type) return 'other';
  if (type.includes('address') || type.includes('street')) return type.includes('street') ? 'street' : 'address';
  if (type.includes('country')) return 'country';
  if (type.includes('region')) return 'region';
  if (type.includes('municipality') || type.includes('city')) return 'city';
  if (type.includes('part') || type.includes('village')) return 'village';
  if (type.startsWith('poi')) return 'poi';
  return 'other';
}

/** Converts one Mapy.com geocode item (exported for tests). */
export function mapyItemToResult(it: z.infer<typeof MapyItemSchema>): GeocodingResult {
  const rs = it.regionalStructure ?? [];
  const country = rs.find((r) => r.type === 'regional.country');
  const region = rs.find((r) => r.type === 'regional.region');
  const countryCode = typeof country?.isoCode === 'string' ? country.isoCode.toUpperCase() : undefined;
  const bbox = it.bbox && it.bbox.length === 4 && isBBox(it.bbox) ? it.bbox : undefined;
  return {
    id: `mapy:${it.type ?? 'x'}:${it.position.lon.toFixed(6)},${it.position.lat.toFixed(6)}:${it.name}`.slice(0, 120),
    name: it.name,
    label: it.location ? `${it.name}, ${it.location}` : it.name,
    lat: it.position.lat,
    lon: it.position.lon,
    kind: mapyKind(it.type),
    country: country?.name,
    countryCode,
    region: region?.name,
    bbox,
    source: 'mapy',
  };
}

export class MapyGeocoder {
  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string | undefined,
    private readonly baseUrl: string = ENDPOINTS.mapy,
  ) {}

  private key(): string {
    if (!this.apiKey?.trim()) throw new TrailPackError('not_configured', 'Pro vyhledávání Mapy.com je potřeba API klíč.', { provider: 'mapy' });
    return this.apiKey.trim();
  }

  private parse(raw: unknown): GeocodingResult[] {
    const parsed = MapyResponseSchema.safeParse(raw);
    if (!parsed.success) throw new TrailPackError('parse_error', 'Odpověď Mapy.com má neočekávaný formát.', { provider: 'mapy', details: parsed.error.issues.slice(0, 3) });
    return parsed.data.items.map(mapyItemToResult);
  }

  /** Full search (`/v1/geocode`). */
  async search(query: string, o: GeocodeOptions = {}): Promise<GeocodingResult[]> {
    const url = buildUrl(`${this.baseUrl}/geocode`, { query, lang: o.lang ?? 'cs', limit: o.limit ?? 8, apikey: this.key() });
    return this.parse(await this.http.json(url, { provider: 'mapy', signal: o.signal }));
  }

  /** Autocomplete (`/v1/suggest`). */
  async suggest(query: string, o: GeocodeOptions = {}): Promise<GeocodingResult[]> {
    const url = buildUrl(`${this.baseUrl}/suggest`, {
      query,
      lang: o.lang ?? 'cs',
      limit: o.limit ?? 8,
      locality: o.countryCodes?.join(','),
      apikey: this.key(),
    });
    return this.parse(await this.http.json(url, { provider: 'mapy', signal: o.signal }));
  }

  async reverse(lat: number, lon: number, o: GeocodeOptions = {}): Promise<GeocodingResult | null> {
    const url = buildUrl(`${this.baseUrl}/rgeocode`, { lat, lon, lang: o.lang ?? 'cs', apikey: this.key() });
    return this.parse(await this.http.json(url, { provider: 'mapy', signal: o.signal }))[0] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface GeocodingServiceOptions {
  http: HttpClient;
  cache?: KeyValueCache;
  photon?: PhotonGeocoder;
  nominatim?: NominatimGeocoder;
  /** Provide to prefer Mapy.com (requires key). */
  mapy?: MapyGeocoder;
  /** Cache TTL for searches (default 24 h). */
  ttlMs?: number;
}

/** Result for coordinates typed into the search box. */
export function coordinatesResult(lat: number, lon: number): GeocodingResult {
  const label = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  return { id: `coords:${lat.toFixed(6)},${lon.toFixed(6)}`, name: label, label: `Souřadnice ${label}`, lat, lon, kind: 'coordinates', source: 'coordinates' };
}

export class GeocodingService {
  readonly photon: PhotonGeocoder;
  readonly nominatim: NominatimGeocoder;
  readonly mapy?: MapyGeocoder;
  private readonly cache?: KeyValueCache;
  private readonly ttl: number;

  constructor(opts: GeocodingServiceOptions) {
    this.photon = opts.photon ?? new PhotonGeocoder(opts.http);
    this.nominatim = opts.nominatim ?? new NominatimGeocoder(opts.http);
    this.mapy = opts.mapy;
    this.cache = opts.cache;
    this.ttl = opts.ttlMs ?? 24 * 3600 * 1000;
  }

  /**
   * Search-as-you-type suggestions: typed coordinates, otherwise Mapy.com
   * (if configured) or Photon. Never calls Nominatim. Queries shorter than 3
   * characters return an empty list.
   */
  async autocomplete(query: string, o: GeocodeOptions = {}): Promise<GeocodingResult[]> {
    const q = query.trim();
    const coords = parseCoordinates(q);
    if (coords) return [coordinatesResult(coords.lat, coords.lon)];
    if (q.length < 3) return [];
    const key = cacheKey('geo:ac', { q: q.toLowerCase(), lang: o.lang ?? 'cs', near: o.near && { lat: +o.near.lat.toFixed(1), lon: +o.near.lon.toFixed(1) }, limit: o.limit, mapy: !!this.mapy });
    const { value } = await cached(this.cache, key, this.ttl, async () => {
      if (this.mapy) {
        try {
          return await this.mapy.suggest(q, o);
        } catch (e) {
          if (e instanceof TrailPackError && (e.code === 'aborted' || e.code === 'invalid_input')) throw e;
        }
      }
      return this.photon.search(q, o);
    });
    return value;
  }

  /**
   * Explicit search (user pressed Enter): typed coordinates, then Mapy.com / Photon,
   * and Nominatim when those fail or find nothing.
   */
  async search(query: string, o: GeocodeOptions = {}): Promise<GeocodingResult[]> {
    const q = query.trim();
    const coords = parseCoordinates(q);
    if (coords) return [coordinatesResult(coords.lat, coords.lon)];
    if (q.length === 0) return [];
    const key = cacheKey('geo:search', { q: q.toLowerCase(), lang: o.lang ?? 'cs', cc: o.countryCodes, limit: o.limit, near: o.near && { lat: +o.near.lat.toFixed(1), lon: +o.near.lon.toFixed(1) } });
    const { value } = await cached(this.cache, key, this.ttl, async () => {
      let first: GeocodingResult[] = [];
      let firstError: unknown;
      try {
        first = this.mapy ? await this.mapy.search(q, o).catch(() => this.photon.search(q, o)) : await this.photon.search(q, o);
      } catch (e) {
        if (e instanceof TrailPackError && e.code === 'aborted') throw e;
        firstError = e;
      }
      if (first.length > 0) return first;
      try {
        return await this.nominatim.search(q, o);
      } catch (e) {
        if (e instanceof TrailPackError && e.code === 'aborted') throw e;
        throw firstError ?? e;
      }
    });
    return value;
  }

  /** Reverse geocoding: Mapy.com (if configured) → Photon → Nominatim. Returns null when nothing is found. */
  async reverse(lat: number, lon: number, o: GeocodeOptions = {}): Promise<GeocodingResult | null> {
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new TrailPackError('invalid_input', 'Neplatné souřadnice.');
    const key = cacheKey('geo:rev', { lat: +lat.toFixed(4), lon: +lon.toFixed(4), lang: o.lang ?? 'cs' });
    const { value } = await cached(this.cache, key, 7 * this.ttl, async () => {
      const chain: Array<() => Promise<GeocodingResult | null>> = [];
      if (this.mapy) chain.push(() => this.mapy!.reverse(lat, lon, o));
      chain.push(() => this.photon.reverse(lat, lon, o), () => this.nominatim.reverse(lat, lon, o));
      let lastError: unknown;
      for (const step of chain) {
        try {
          const r = await step();
          if (r) return r;
        } catch (e) {
          if (e instanceof TrailPackError && e.code === 'aborted') throw e;
          lastError = e;
        }
      }
      if (lastError && chain.length > 0) throw lastError;
      return null;
    });
    return value;
  }
}
