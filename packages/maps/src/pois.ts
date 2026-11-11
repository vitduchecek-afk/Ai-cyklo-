/**
 * Points of interest from OpenStreetMap via the Overpass API.
 *
 * Fair use: queries are small (`[timeout:25]`), corridors are chunked, results
 * cached (default 24 h, served stale when offline), requests are sent one at a
 * time to a mirror list with failover. Data © OpenStreetMap contributors, ODbL.
 */
import type { BBox, Campsite, CampsiteType, Confidence, DataSource, KeyValueCache, LegalStatus, Position, Potability, ProtectedAreaInfo, WaterSource, WaterSourceType } from '@trailpack/shared';
import { ENDPOINTS, HttpClient, TrailPackError, cacheKey, cached } from '@trailpack/shared';
import { bboxOf, haversine, nearestPointOnLine, simplifyLine, cumulativeDistances } from '@trailpack/calculations';
import type { ProtectedAreaKind } from '@trailpack/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  /** ISO timestamp of the last edit (present with `out meta`). */
  timestamp?: string;
  version?: number;
}

export interface OverpassResponse {
  elements: OverpassElement[];
  /** Date of the OSM data snapshot behind the answer, if reported. */
  dataTimestamp?: string;
}

export type PoiArea = { bbox: BBox } | { route: Position[]; corridorM: number };

export interface AlongRoute {
  /** Distance of the POI from the route line, meters. */
  distanceFromRouteM: number;
  /** Distance from the route start to the POI's closest point on the route, meters. */
  alongRouteM: number;
}

export type WaterSourceAlong = WaterSource & AlongRoute;
export type CampsiteAlong = Campsite & AlongRoute;

export interface Peak {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** meters above sea level */
  eleM?: number;
  source: DataSource;
}

export type TransportKind = 'bus' | 'train' | 'tram' | 'other';

export interface TransportStop {
  id: string;
  name?: string;
  kind: TransportKind;
  lat: number;
  lon: number;
  /** Distance from the query point, meters. */
  distanceM: number;
  operator?: string;
  ref?: string;
  source: DataSource;
}

export interface OverpassClientOptions {
  /** Mirrors tried in order. Default `ENDPOINTS.overpass`. */
  endpoints?: readonly string[];
  cache?: KeyValueCache;
  /** Cache lifetime (default 24 h). */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAILOVER_CODES = new Set(['network', 'timeout', 'rate_limited', 'provider_error', 'forbidden']);
const MAX_AROUND_POINTS = 150;
const MAX_CHUNKS = 12;

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const normText = (s: string): string => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const yes = (v: string | undefined): boolean | null => (v === 'yes' || v === 'true' || v === '1' ? true : v === 'no' || v === 'false' || v === '0' ? false : null);

function parseNumber(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v.replace(',', '.').replace(/\s*m$/i, ''));
  return Number.isFinite(n) ? n : undefined;
}

function elementPosition(el: OverpassElement): { lat: number; lon: number } | undefined {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  return lat !== undefined && lon !== undefined && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : undefined;
}

function isoOrUndefined(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function osmSource(el: OverpassElement, retrievedAt: string): DataSource {
  const ref = `${el.type}/${el.id}`;
  const src: DataSource = { provider: 'openstreetmap', ref, url: `https://www.openstreetmap.org/${ref}`, license: 'ODbL', retrievedAt };
  const edited = isoOrUndefined(el.timestamp);
  if (edited) src.lastEditedAt = edited;
  return src;
}

const entityId = (el: OverpassElement) => `osm:${el.type}/${el.id}`;
const displayName = (tags: Record<string, string>): string | undefined => {
  const n = tags['name:cs'] ?? tags.name ?? tags['name:sk'] ?? tags.alt_name;
  return n ? n.slice(0, 200) : undefined;
};

const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const parseDate = (s: string | undefined): number | undefined => {
  if (!s) return undefined;
  const t = Date.parse(s.length === 7 ? `${s}-01` : s);
  return Number.isFinite(t) ? t : undefined;
};

// ---------------------------------------------------------------------------
// Mapping: water
// ---------------------------------------------------------------------------

/** OSM tags → water source type, or undefined when the element is not a water source. */
export function waterSourceType(tags: Record<string, string>): WaterSourceType | undefined {
  if (tags.amenity === 'drinking_water') return 'drinking_water';
  if (tags.natural === 'spring') return 'spring';
  if (tags.man_made === 'water_well') return 'well';
  if (tags.man_made === 'water_tap' || tags.amenity === 'water_point') return 'water_tap';
  if (tags.amenity === 'fountain') return 'fountain';
  if (tags.tourism === 'alpine_hut' || tags.tourism === 'wilderness_hut') return 'hut';
  if (tags.tourism === 'camp_site') return 'campsite';
  return undefined;
}

/** Potability from OSM tags; `natural=spring` defaults to 'unknown' (never assume safe). */
export function waterPotability(tags: Record<string, string>): Potability {
  const dw = tags.drinking_water;
  if (dw === 'yes') return 'potable';
  if (dw === 'no') return 'not_potable';
  if (dw && ['conditional', 'filter', 'boil', 'treat', 'treated'].includes(dw)) return 'treat';
  if (tags.amenity === 'drinking_water') return tags.access === 'private' || tags.access === 'no' ? 'unknown' : 'potable';
  return 'unknown';
}

/**
 * Confidence in the water record (points: explicit potability tag +1, survey/check date ≤ 3 y +2,
 * last edit ≤ 2 y +1, last edit > 6 y −1; ≥ 3 high, ≥ 1 medium, else low).
 */
export function waterConfidence(tags: Record<string, string>, editedAt: string | undefined, now: Date): Confidence {
  let pts = 0;
  if (tags.drinking_water || tags.amenity === 'drinking_water') pts += 1;
  const checked = parseDate(tags['check_date:drinking_water'] ?? tags.check_date ?? tags['survey:date']);
  if (checked !== undefined && (now.getTime() - checked) / YEAR_MS <= 3) pts += 2;
  const edited = parseDate(editedAt);
  if (edited !== undefined) {
    const age = (now.getTime() - edited) / YEAR_MS;
    if (age <= 2) pts += 1;
    else if (age > 6) pts -= 1;
  }
  return pts >= 3 ? 'high' : pts >= 1 ? 'medium' : 'low';
}

/** Converts an Overpass element to a `WaterSource`, or null if it is not one / has no position. */
export function osmToWaterSource(el: OverpassElement, retrievedAt: string, now: Date = new Date()): WaterSource | null {
  const tags = el.tags ?? {};
  const type = waterSourceType(tags);
  const pos = elementPosition(el);
  if (!type || !pos) return null;
  if ((type === 'hut' || type === 'campsite') && tags.drinking_water !== 'yes') return null;
  const potability = waterPotability(tags);
  const seasonalTag = tags.seasonal;
  const seasonal = seasonalTag ? (seasonalTag === 'no' ? false : true) : tags.intermittent === 'yes' ? true : null;
  const notes: string[] = [];
  if (potability === 'unknown') notes.push('Kvalita vody není v OpenStreetMap uvedena – před pitím ji upravte (filtr, převaření).');
  if (potability === 'not_potable') notes.push('Voda je označena jako nepitná.');
  if (potability === 'treat') notes.push('Voda vyžaduje úpravu před pitím.');
  if (seasonal === true) notes.push(seasonalTag && seasonalTag !== 'yes' ? `Sezónní zdroj (${seasonalTag}).` : 'Sezónní zdroj – v suchu může vyschnout.');
  if (tags.fee === 'yes') notes.push('Zpoplatněno.');
  if (tags.access === 'private' || tags.access === 'no') notes.push('Přístup je v OSM označen jako omezený.');
  const checked = tags['check_date:drinking_water'] ?? tags.check_date ?? tags['survey:date'];
  if (checked) notes.push(`Naposledy ověřeno: ${checked}.`);
  const source = osmSource(el, retrievedAt);
  const ws: WaterSource = {
    id: entityId(el),
    createdAt: retrievedAt,
    updatedAt: retrievedAt,
    deletedAt: null,
    type,
    lat: pos.lat,
    lon: pos.lon,
    potability,
    seasonal,
    confidence: waterConfidence(tags, source.lastEditedAt, now),
    source,
  };
  const name = displayName(tags);
  if (name) ws.name = name;
  const ele = parseNumber(tags.ele);
  if (ele !== undefined) ws.eleM = ele;
  if (notes.length) ws.notes = notes.join(' ').slice(0, 2000);
  return ws;
}

// ---------------------------------------------------------------------------
// Mapping: campsites
// ---------------------------------------------------------------------------

/** OSM tags → campsite type, or undefined when it is not a (sleeping) facility. */
export function campsiteType(tags: Record<string, string>): CampsiteType | undefined {
  switch (tags.tourism) {
    case 'camp_site':
      return tags.backcountry === 'yes' ? 'bivouac_site' : 'campground';
    case 'alpine_hut':
      return 'alpine_hut';
    case 'wilderness_hut':
      return 'wilderness_hut';
    case 'hostel':
      return 'hostel';
    case 'hotel':
      return 'hotel';
    default:
      break;
  }
  if (tags.amenity === 'shelter') {
    // bus stops and tram shelters are not places to sleep
    if (tags.bus === 'yes' || tags.public_transport || tags.shelter_type === 'public_transport') return undefined;
    return 'shelter';
  }
  return undefined;
}

/** Legal status of an overnight stay at the facility, with Czech explanation. */
export function campsiteLegal(tags: Record<string, string>, type: CampsiteType): { legalStatus: LegalStatus; legalNote: string } {
  if (tags.access === 'private' || tags.access === 'no') {
    return { legalStatus: 'prohibited', legalNote: 'Přístup je v OpenStreetMap označen jako soukromý nebo zakázaný – nocování zde není dovoleno.' };
  }
  if (type === 'campground' || type === 'bivouac_site' || type === 'alpine_hut' || type === 'wilderness_hut') {
    const conditional = tags.access === 'permit' || tags.access === 'customers' || tags.access === 'members';
    const what = type === 'alpine_hut' ? 'horská chata' : type === 'wilderness_hut' ? 'nouzová/otevřená chata' : type === 'bivouac_site' ? 'vyhrazené místo pro bivak' : 'kemp';
    if (conditional) {
      return { legalStatus: 'conditional', legalNote: `Zařízení (${what}) je přístupné jen s povolením nebo pro zákazníky – ověřte podmínky u provozovatele.` };
    }
    return { legalStatus: 'verified_allowed', legalNote: `Oficiální zařízení (${what}) podle OpenStreetMap. Ověřte provozní dobu, poplatky a případnou rezervaci.` };
  }
  if (type === 'shelter') {
    return { legalStatus: 'unverified', legalNote: 'Přístřešek – nocování závisí na majiteli pozemku a pravidlech chráněného území; zákonnost není ověřena.' };
  }
  return { legalStatus: 'unverified', legalNote: 'Zákonnost nocování není ověřena.' };
}

function safeUrl(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    return new URL(s).toString();
  } catch {
    return undefined;
  }
}

/** Converts an Overpass element to a `Campsite`, or null. */
export function osmToCampsite(el: OverpassElement, retrievedAt: string): Campsite | null {
  const tags = el.tags ?? {};
  const type = campsiteType(tags);
  const pos = elementPosition(el);
  if (!type || !pos) return null;
  const legal = campsiteLegal(tags, type);
  const reservationTag = tags.reservation;
  const reservation: Campsite['reservation'] = reservationTag === 'required' ? 'required' : reservationTag === 'recommended' || reservationTag === 'yes' ? 'recommended' : reservationTag === 'no' ? 'no' : 'unknown';
  const capacity = [tags.capacity, tags.beds, tags['capacity:persons']].map((v) => (v ? Number.parseInt(v, 10) : Number.NaN)).find((n) => Number.isInteger(n) && n > 0);
  const c: Campsite = {
    id: entityId(el),
    createdAt: retrievedAt,
    updatedAt: retrievedAt,
    deletedAt: null,
    type,
    lat: pos.lat,
    lon: pos.lon,
    water: yes(tags.drinking_water),
    toilets: yes(tags.toilets),
    shelter: type === 'shelter' || type === 'wilderness_hut' || type === 'alpine_hut' ? true : yes(tags.shelter),
    fireplace: tags.fireplace ? yes(tags.fireplace) : tags.openfire ? yes(tags.openfire) : null,
    capacity: capacity ?? null,
    fee: yes(tags.fee),
    reservation,
    legalStatus: legal.legalStatus,
    legalNote: legal.legalNote,
    tents: yes(tags.tents),
    source: osmSource(el, retrievedAt),
  };
  const name = displayName(tags);
  if (name) c.name = name;
  const ele = parseNumber(tags.ele);
  if (ele !== undefined) c.eleM = ele;
  if (tags.charge) c.priceText = tags.charge.slice(0, 200);
  const website = safeUrl(tags.website ?? tags['contact:website'] ?? tags.url);
  if (website) c.website = website;
  const phone = tags.phone ?? tags['contact:phone'];
  if (phone) c.phone = phone.slice(0, 60);
  if (tags.opening_hours) c.openingHours = tags.opening_hours.slice(0, 200);
  return c;
}

// ---------------------------------------------------------------------------
// Mapping: protected areas
// ---------------------------------------------------------------------------

const KIND_ORDER: ProtectedAreaKind[] = ['national_park', 'nature_reserve', 'natural_monument', 'protected_landscape_area', 'natura2000', 'other'];

const DEFAULT_DESIGNATION: Record<ProtectedAreaKind, string> = {
  national_park: 'Národní park',
  protected_landscape_area: 'Chráněná krajinná oblast',
  nature_reserve: 'Přírodní rezervace',
  natural_monument: 'Přírodní památka',
  natura2000: 'Natura 2000',
  other: 'Chráněné území',
};

/** Classifies a protected area from designation text (CZ/SK/PL/EN) and OSM tags. */
export function classifyProtectedArea(tags: Record<string, string>): ProtectedAreaKind {
  const texts = [tags.designation, tags.protection_title, tags['name:cs'] ?? tags.name].filter((t): t is string => !!t).map(normText);
  const rules: Array<[ProtectedAreaKind, RegExp]> = [
    ['natural_monument', /prirodni pamatka|prirodna pamiatka|pomnik przyrody|natural monument|\bnpp\b|\bpp\b/],
    ['nature_reserve', /prirodni rezervace|prirodna rezervacia|rezerwat|nature reserve|\bnpr\b|\bpr\b/],
    ['national_park', /narodni park|narodny park|park narodowy|national park|\bnp\b/],
    ['protected_landscape_area', /chranena krajinna oblast|\bchko\b|park krajobrazowy|obszar chronionego krajobrazu|protected landscape|landscape protected/],
    ['natura2000', /natura 2000|ptaci oblast|evropsky vyznamna lokalita|\bevl\b|specjalny obszar ochrony|obszar specjalnej ochrony|special area of conservation|special protection area/],
  ];
  for (const text of texts) for (const [kind, re] of rules) if (re.test(text)) return kind;
  if (tags.boundary === 'national_park') return 'national_park';
  if (tags.leisure === 'nature_reserve') return 'nature_reserve';
  switch (tags.protect_class) {
    case '2':
      return 'national_park';
    case '1':
    case '1a':
    case '1b':
    case '4':
      return 'nature_reserve';
    case '3':
      return 'natural_monument';
    case '5':
      return 'protected_landscape_area';
    default:
      return 'other';
  }
}

function protectedAreaCountry(tags: Record<string, string>): string | undefined {
  const iso = tags['ISO3166-1'] ?? tags['ISO3166-1:alpha2'];
  if (iso && /^[A-Za-z]{2}$/.test(iso)) return iso.toUpperCase();
  const raw = [tags.designation, tags.protection_title, tags['name:cs'] ?? tags.name].filter(Boolean).join(' ').toLowerCase();
  if (/park narodowy|rezerwat|park krajobrazowy|pomnik przyrody|obszar chronionego/.test(raw)) return 'PL';
  if (/národn[ýé]\s|chránen[áé]\s|prírodn[áé]|oblasť|pamiatka|rezerváci/.test(raw)) return 'SK';
  if (/národní|chráněn|přírodní|oblast\b|rezervace|památka|ě|ř|ů/.test(raw)) return 'CZ';
  return undefined;
}

/** Converts a relation/way with protection tags to `ProtectedAreaInfo`, or null if it is not a protected area. */
export function osmToProtectedArea(el: OverpassElement): ProtectedAreaInfo | null {
  const tags = el.tags ?? {};
  const isProtected = tags.boundary === 'national_park' || tags.boundary === 'protected_area' || tags.leisure === 'nature_reserve';
  if (!isProtected) return null;
  const kind = classifyProtectedArea(tags);
  const info: ProtectedAreaInfo = {
    name: displayName(tags) ?? tags.designation ?? DEFAULT_DESIGNATION[kind],
    kind,
    designation: (tags.designation ?? tags.protection_title ?? DEFAULT_DESIGNATION[kind]).slice(0, 200),
    osmRef: `${el.type}/${el.id}`,
  };
  if (tags.protect_class) info.protectClass = tags.protect_class;
  const zone = tags.zone ?? tags.protection_zone ?? tags.zona;
  if (zone) info.zone = zone;
  const cc = protectedAreaCountry(tags);
  if (cc) info.countryCode = cc;
  return info;
}

// ---------------------------------------------------------------------------
// Mapping: peaks, transport
// ---------------------------------------------------------------------------

export function osmToPeak(el: OverpassElement, retrievedAt: string): Peak | null {
  const tags = el.tags ?? {};
  const pos = elementPosition(el);
  const name = displayName(tags);
  if (!pos || !name || tags.natural !== 'peak') return null;
  const peak: Peak = { id: entityId(el), name, lat: pos.lat, lon: pos.lon, source: osmSource(el, retrievedAt) };
  const ele = parseNumber(tags.ele);
  if (ele !== undefined) peak.eleM = ele;
  return peak;
}

export function osmToTransportStop(el: OverpassElement, from: { lat: number; lon: number }, retrievedAt: string): TransportStop | null {
  const tags = el.tags ?? {};
  const pos = elementPosition(el);
  if (!pos) return null;
  let kind: TransportKind | undefined;
  if (tags.highway === 'bus_stop') kind = 'bus';
  else if (tags.railway === 'station' || tags.railway === 'halt') kind = 'train';
  else if (tags.railway === 'tram_stop') kind = 'tram';
  else if (tags.public_transport === 'station') kind = 'other';
  if (!kind) return null;
  const stop: TransportStop = { id: entityId(el), kind, lat: pos.lat, lon: pos.lon, distanceM: Math.round(haversine(from, pos)), source: osmSource(el, retrievedAt) };
  const name = displayName(tags);
  if (name) stop.name = name;
  if (tags.operator) stop.operator = tags.operator;
  if (tags.ref) stop.ref = tags.ref;
  return stop;
}

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

const WATER_SELECTORS = [
  'node["natural"="spring"]',
  'node["amenity"="drinking_water"]',
  'node["man_made"="water_tap"]',
  'node["man_made"="water_well"]',
  'node["amenity"="water_point"]',
  'node["amenity"="fountain"]["drinking_water"="yes"]',
  'nwr["tourism"~"^(alpine_hut|wilderness_hut|camp_site)$"]["drinking_water"="yes"]',
];

const CAMP_SELECTORS = [
  'nwr["tourism"="camp_site"]',
  'nwr["tourism"="alpine_hut"]',
  'nwr["tourism"="wilderness_hut"]',
  'nwr["amenity"="shelter"]["shelter_type"!="public_transport"]["bus"!="yes"]',
];

const r6 = (v: number) => (Math.round(v * 1e6) / 1e6).toString();

/** Overpass bbox filter `(south,west,north,east)`. */
export const bboxFilter = ([w, s, e, n]: BBox): string => `(${r6(s)},${r6(w)},${r6(n)},${r6(e)})`;

/** Overpass `around` filter along a polyline. */
export const aroundFilter = (radiusM: number, points: readonly Position[]): string => `(around:${Math.round(radiusM)},${points.map((p) => `${r6(p[1])},${r6(p[0])}`).join(',')})`;

/** Wraps selectors into one `[out:json][timeout:25]` query ending with `out center meta tags;`. */
export function buildOverpassQuery(selectors: readonly string[], filter: string, limit?: number): string {
  return `[out:json][timeout:25];\n(\n${selectors.map((s) => `  ${s}${filter};`).join('\n')}\n);\nout center meta tags${limit ? ` ${limit}` : ''};`;
}

/**
 * Splits a route into overlapping pieces with ≤ `maxPoints` vertices after
 * simplification (tolerance corridor/4, raised until at most 12 pieces remain),
 * suitable for `around:` queries.
 */
export function corridorChunks(route: readonly Position[], corridorM: number, maxPoints = MAX_AROUND_POINTS): Position[][] {
  if (route.length === 0) return [];
  if (route.length === 1) return [[route[0]!, route[0]!]];
  let tol = Math.max(5, corridorM / 4);
  let line = simplifyLine(route, tol);
  while (line.length > maxPoints * MAX_CHUNKS && tol < 5000) {
    tol *= 1.6;
    line = simplifyLine(route, tol);
  }
  const chunks: Position[][] = [];
  for (let i = 0; i < line.length - 1; i += maxPoints - 1) chunks.push(line.slice(i, Math.min(line.length, i + maxPoints)));
  return chunks;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class OverpassClient {
  private readonly endpoints: readonly string[];
  private readonly cache?: KeyValueCache;
  private readonly ttl: number;
  private readonly now: () => Date;

  constructor(
    private readonly http: HttpClient,
    opts: OverpassClientOptions = {},
  ) {
    this.endpoints = opts.endpoints ?? ENDPOINTS.overpass;
    this.cache = opts.cache;
    this.ttl = opts.ttlMs ?? 24 * 3600 * 1000;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Runs a raw Overpass QL query (POST form `data=`) with mirror failover and caching.
   * @throws TrailPackError `network`/`timeout`/`rate_limited`/`provider_error` after all mirrors failed.
   */
  async query(ql: string, signal?: AbortSignal): Promise<OverpassResponse> {
    const { value } = await cached(this.cache, cacheKey('overpass:v1', fnv1a(ql)), this.ttl, () => this.queryUncached(ql, signal));
    return value;
  }

  private async queryUncached(ql: string, signal?: AbortSignal): Promise<OverpassResponse> {
    let lastError: TrailPackError | undefined;
    for (const endpoint of this.endpoints) {
      try {
        const res = await this.http.request(endpoint, {
          method: 'POST',
          rawBody: `data=${encodeURIComponent(ql)}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          provider: 'overpass',
          signal,
          timeoutMs: 40_000,
        });
        const text = await res.text();
        let json: { elements?: OverpassElement[]; remark?: string; osm3s?: { timestamp_osm_base?: string } };
        try {
          json = JSON.parse(text);
        } catch (e) {
          throw new TrailPackError('provider_error', 'Overpass vrátil neplatnou odpověď (pravděpodobně přetížený server).', { provider: 'overpass', cause: e, retryable: true });
        }
        if (json.remark && /runtime error|out of memory/i.test(json.remark)) {
          throw new TrailPackError('provider_error', `Overpass nedokončil dotaz: ${json.remark.slice(0, 120)}`, { provider: 'overpass', retryable: true });
        }
        if (!Array.isArray(json.elements)) {
          throw new TrailPackError('parse_error', 'Odpověď Overpass nemá očekávaný formát.', { provider: 'overpass' });
        }
        return { elements: json.elements, dataTimestamp: json.osm3s?.timestamp_osm_base };
      } catch (e) {
        if (!(e instanceof TrailPackError)) throw e;
        lastError = e;
        if (!FAILOVER_CODES.has(e.code)) throw e;
      }
    }
    throw lastError ?? new TrailPackError('not_configured', 'Není nastaven žádný server Overpass.', { provider: 'overpass' });
  }

  private async fetchArea(selectors: readonly string[], area: PoiArea, signal?: AbortSignal): Promise<OverpassElement[]> {
    const queries = 'bbox' in area ? [buildOverpassQuery(selectors, bboxFilter(area.bbox))] : corridorChunks(area.route, area.corridorM).map((c) => buildOverpassQuery(selectors, aroundFilter(area.corridorM, c)));
    const seen = new Set<string>();
    const out: OverpassElement[] = [];
    for (const q of queries) {
      const res = await this.query(q, signal);
      for (const el of res.elements) {
        const key = `${el.type}/${el.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(el);
      }
    }
    return out;
  }

  private async mapArea<T extends { lat: number; lon: number }>(
    selectors: readonly string[],
    area: PoiArea,
    map: (el: OverpassElement, retrievedAt: string) => T | null,
    signal?: AbortSignal,
  ): Promise<Array<T & Partial<AlongRoute>>> {
    const retrievedAt = this.now().toISOString();
    const elements = await this.fetchArea(selectors, area, signal);
    const items = elements.map((el) => map(el, retrievedAt)).filter((x): x is T => x !== null);
    if ('bbox' in area) return items;
    return alongRoute(items, area.route, area.corridorM);
  }

  /** Springs, drinking water, taps, wells (and huts/camps with drinking water) in a bbox or along a route. */
  waterSourcesNear(area: { bbox: BBox }, signal?: AbortSignal): Promise<WaterSource[]>;
  waterSourcesNear(area: { route: Position[]; corridorM: number }, signal?: AbortSignal): Promise<WaterSourceAlong[]>;
  async waterSourcesNear(area: PoiArea, signal?: AbortSignal): Promise<WaterSource[] | WaterSourceAlong[]> {
    const now = this.now();
    return (await this.mapArea(WATER_SELECTORS, area, (el, at) => osmToWaterSource(el, at, now), signal)) as WaterSource[];
  }

  /** Campsites, huts and shelters in a bbox or along a route. */
  campsitesNear(area: { bbox: BBox }, signal?: AbortSignal): Promise<Campsite[]>;
  campsitesNear(area: { route: Position[]; corridorM: number }, signal?: AbortSignal): Promise<CampsiteAlong[]>;
  async campsitesNear(area: PoiArea, signal?: AbortSignal): Promise<Campsite[] | CampsiteAlong[]> {
    return (await this.mapArea(CAMP_SELECTORS, area, osmToCampsite, signal)) as Campsite[];
  }

  /** Named peaks in a bbox, highest first, at most `limit`. */
  async peaksIn(bbox: BBox, limit = 50, signal?: AbortSignal): Promise<Peak[]> {
    const res = await this.query(buildOverpassQuery(['node["natural"="peak"]["name"]'], bboxFilter(bbox), 2000), signal);
    const at = this.now().toISOString();
    return res.elements
      .map((el) => osmToPeak(el, at))
      .filter((p): p is Peak => p !== null)
      .sort((a, b) => (b.eleM ?? -Infinity) - (a.eleM ?? -Infinity))
      .slice(0, Math.max(0, limit));
  }

  /** Bus stops and railway stops within `radiusM` of a point, nearest first. */
  async transportNear(lat: number, lon: number, radiusM = 1500, signal?: AbortSignal): Promise<TransportStop[]> {
    const around = `(around:${Math.round(radiusM)},${r6(lat)},${r6(lon)})`;
    const res = await this.query(buildOverpassQuery(['node["highway"="bus_stop"]', 'node["railway"~"^(station|halt|tram_stop)$"]', 'node["public_transport"="station"]'], around), signal);
    const at = this.now().toISOString();
    return res.elements
      .map((el) => osmToTransportStop(el, { lat, lon }, at))
      .filter((s): s is TransportStop => s !== null)
      .sort((a, b) => a.distanceM - b.distanceM);
  }

  /** Protected areas (national parks, CHKO, reserves, …) that contain the point. */
  async protectedAreasAt(lat: number, lon: number, signal?: AbortSignal): Promise<ProtectedAreaInfo[]> {
    const ql = `[out:json][timeout:25];\nis_in(${r6(lat)},${r6(lon)})->.a;\n(\n  nwr(pivot.a)["boundary"="national_park"];\n  nwr(pivot.a)["boundary"="protected_area"];\n  nwr(pivot.a)["leisure"="nature_reserve"];\n);\nout center meta tags;`;
    const res = await this.query(ql, signal);
    const seen = new Set<string>();
    const out: ProtectedAreaInfo[] = [];
    for (const el of res.elements) {
      const info = osmToProtectedArea(el);
      if (!info || (info.osmRef && seen.has(info.osmRef))) continue;
      if (info.osmRef) seen.add(info.osmRef);
      out.push(info);
    }
    return out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  }
}

/** Adds `distanceFromRouteM` / `alongRouteM`, drops items beyond the corridor, sorts by position along the route. */
export function alongRoute<T extends { lat: number; lon: number }>(items: readonly T[], route: readonly Position[], corridorM: number): Array<T & AlongRoute> {
  if (route.length === 0) return [];
  const scoring = route.length > 5000 ? simplifyLine(route, 5) : route;
  const cum = cumulativeDistances(scoring);
  return items
    .map((it) => {
      const n = nearestPointOnLine(scoring, { lat: it.lat, lon: it.lon }, cum);
      return { ...it, distanceFromRouteM: Math.round(n.distanceM), alongRouteM: Math.round(n.alongM) };
    })
    .filter((it) => it.distanceFromRouteM <= corridorM)
    .sort((a, b) => a.alongRouteM - b.alongRouteM || a.distanceFromRouteM - b.distanceFromRouteM);
}

export { bboxOf };
