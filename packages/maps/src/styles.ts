/**
 * Map style catalogue and helpers. Styles are plain MapLibre style JSON
 * (spec v8); this package only builds/fetches them, rendering is done by the app.
 *
 * Tile usage policies:
 * - OpenFreeMap vector tiles: free, no key; offline caching of regions is allowed (zoom ≤ 14).
 * - OpenTopoMap, EOX, Waymarked Trails, Mapy.com: online only – bulk downloading is not permitted
 *   (`offlineAllowed: false`).
 */
import type { BBox, KeyValueCache, Position, RouteWaypoint, TrackPoint, WaterSource, Campsite } from '@trailpack/shared';
import { ENDPOINTS, HttpClient, TrailPackError, cached } from '@trailpack/shared';
import { lineLength } from '@trailpack/calculations';

// ---------------------------------------------------------------------------
// Minimal MapLibre style types
// ---------------------------------------------------------------------------

export interface StyleSource {
  type: 'vector' | 'raster' | 'raster-dem' | 'geojson';
  url?: string;
  tiles?: string[];
  tileSize?: number;
  minzoom?: number;
  maxzoom?: number;
  attribution?: string;
  encoding?: 'terrarium' | 'mapbox';
  data?: unknown;
  [key: string]: unknown;
}

export interface StyleLayer {
  id: string;
  type: string;
  source?: string;
  'source-layer'?: string;
  minzoom?: number;
  maxzoom?: number;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
  filter?: unknown;
  [key: string]: unknown;
}

export interface StyleJson {
  version: 8;
  name?: string;
  sources: Record<string, StyleSource>;
  layers: StyleLayer[];
  glyphs?: string;
  sprite?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export type BaseStyleId = 'outdoor' | 'standard' | 'light' | 'topo' | 'satellite' | 'mapy_outdoor' | 'mapy_aerial' | 'mapy_winter' | 'mapy_basic';
export type OverlayId = 'hiking_trails' | 'cycling_trails' | 'mtb_trails' | 'hillshade';
export type StyleKind = 'vector' | 'raster';

export interface BaseStyleInfo {
  id: BaseStyleId;
  /** Czech display name. */
  name: string;
  kind: StyleKind;
  requiresKey?: boolean;
  attribution: string;
  /** Whether regions of this style may be downloaded for offline use. */
  offlineAllowed: boolean;
  /** Highest zoom that may be stored offline (vector tiles overzoom beyond it). */
  maxOfflineZoom: number;
}

export interface OverlayInfo {
  id: OverlayId;
  name: string;
  attribution: string;
}

const OSM_ATTR = '© přispěvatelé OpenStreetMap';
const OFM_ATTR = '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
const MAPY_ATTR = '© Seznam.cz a.s. a další · Mapy.com';

export const BASE_STYLES: Readonly<Record<BaseStyleId, BaseStyleInfo>> = {
  outdoor: { id: 'outdoor', name: 'Turistická', kind: 'vector', attribution: `${OFM_ATTR} · Waymarked Trails · Terrarium DEM`, offlineAllowed: true, maxOfflineZoom: 14 },
  standard: { id: 'standard', name: 'Standardní', kind: 'vector', attribution: OFM_ATTR, offlineAllowed: true, maxOfflineZoom: 14 },
  light: { id: 'light', name: 'Světlá', kind: 'vector', attribution: OFM_ATTR, offlineAllowed: true, maxOfflineZoom: 14 },
  topo: { id: 'topo', name: 'Topografická (OpenTopoMap)', kind: 'raster', attribution: `Mapová data: ${OSM_ATTR}, SRTM | Styl: © OpenTopoMap (CC-BY-SA)`, offlineAllowed: false, maxOfflineZoom: 0 },
  satellite: {
    id: 'satellite',
    name: 'Satelitní',
    kind: 'raster',
    attribution: 'Sentinel-2 cloudless – s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)',
    offlineAllowed: false,
    maxOfflineZoom: 0,
  },
  mapy_outdoor: { id: 'mapy_outdoor', name: 'Mapy.com – turistická', kind: 'raster', requiresKey: true, attribution: MAPY_ATTR, offlineAllowed: false, maxOfflineZoom: 0 },
  mapy_aerial: { id: 'mapy_aerial', name: 'Mapy.com – letecká', kind: 'raster', requiresKey: true, attribution: MAPY_ATTR, offlineAllowed: false, maxOfflineZoom: 0 },
  mapy_winter: { id: 'mapy_winter', name: 'Mapy.com – zimní', kind: 'raster', requiresKey: true, attribution: MAPY_ATTR, offlineAllowed: false, maxOfflineZoom: 0 },
  mapy_basic: { id: 'mapy_basic', name: 'Mapy.com – základní', kind: 'raster', requiresKey: true, attribution: MAPY_ATTR, offlineAllowed: false, maxOfflineZoom: 0 },
};

export const OVERLAYS: Readonly<Record<OverlayId, OverlayInfo>> = {
  hiking_trails: { id: 'hiking_trails', name: 'Turistické trasy', attribution: '© Waymarked Trails (CC-BY-SA)' },
  cycling_trails: { id: 'cycling_trails', name: 'Cyklotrasy', attribution: '© Waymarked Trails (CC-BY-SA)' },
  mtb_trails: { id: 'mtb_trails', name: 'MTB trasy', attribution: '© Waymarked Trails (CC-BY-SA)' },
  hillshade: { id: 'hillshade', name: 'Stínování reliéfu', attribution: 'Terrain: Mapzen/AWS Terrain Tiles (SRTM, NED, …)' },
};

export const listBaseStyles = (): BaseStyleInfo[] => Object.values(BASE_STYLES);
export const listOverlays = (): OverlayInfo[] => Object.values(OVERLAYS);

/** Overlays that are part of the 'outdoor' preset. */
export const OUTDOOR_DEFAULT_OVERLAYS: readonly OverlayId[] = ['hillshade', 'hiking_trails'];

/** OpenFreeMap style name for a vector base. */
const OFM_STYLE_NAME: Partial<Record<BaseStyleId, string>> = { outdoor: 'liberty', standard: 'bright', light: 'positron' };

export const ofmStyleUrl = (id: BaseStyleId): string | undefined => {
  const n = OFM_STYLE_NAME[id];
  return n ? `${ENDPOINTS.openFreeMapStyles}/${n}` : undefined;
};

const MAPY_SETS: Partial<Record<BaseStyleId, string>> = { mapy_outdoor: 'outdoor', mapy_aerial: 'aerial', mapy_winter: 'winter', mapy_basic: 'basic' };

// ---------------------------------------------------------------------------
// Style builders
// ---------------------------------------------------------------------------

export interface RasterStyleOptions {
  id: string;
  name?: string;
  tiles: string[];
  tileSize?: number;
  minzoom?: number;
  maxzoom?: number;
  attribution?: string;
}

/** A style consisting of one raster tile source (plus background so empty tiles are not transparent). */
export function rasterStyle(o: RasterStyleOptions): StyleJson {
  return {
    version: 8,
    name: o.name ?? o.id,
    sources: {
      [o.id]: { type: 'raster', tiles: o.tiles, tileSize: o.tileSize ?? 256, minzoom: o.minzoom ?? 0, maxzoom: o.maxzoom ?? 19, attribution: o.attribution },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#e8ecdf' } },
      { id: `${o.id}-raster`, type: 'raster', source: o.id },
    ],
  };
}

/** Raster base style for the non-OpenFreeMap catalogue entries. */
export function rasterBaseStyle(id: BaseStyleId, mapyApiKey?: string): StyleJson {
  const info = BASE_STYLES[id];
  if (info.requiresKey && !mapyApiKey) {
    throw new TrailPackError('not_configured', 'Pro mapy Mapy.com je potřeba API klíč. Přidejte ho v Nastavení → Mapové služby.', { provider: 'mapy' });
  }
  switch (id) {
    case 'topo':
      return rasterStyle({ id, name: info.name, tiles: [ENDPOINTS.openTopoMap], maxzoom: 17, attribution: info.attribution });
    case 'satellite':
      return rasterStyle({ id, name: info.name, tiles: [ENDPOINTS.eoxS2Cloudless2016], maxzoom: 13, attribution: info.attribution });
    case 'mapy_outdoor':
    case 'mapy_aerial':
    case 'mapy_winter':
    case 'mapy_basic':
      return rasterStyle({
        id,
        name: info.name,
        tiles: [`${ENDPOINTS.mapy}/maptiles/${MAPY_SETS[id]}/256/{z}/{x}/{y}?apikey=${encodeURIComponent(mapyApiKey!)}`],
        maxzoom: 19,
        attribution: info.attribution,
      });
    default:
      throw new TrailPackError('invalid_input', `Styl "${id}" není rastrový.`);
  }
}

function overlayParts(id: OverlayId): { sources: Record<string, StyleSource>; layers: StyleLayer[]; attribution: string } {
  const attribution = OVERLAYS[id].attribution;
  const trails = (src: string, url: string): { sources: Record<string, StyleSource>; layers: StyleLayer[]; attribution: string } => ({
    sources: { [src]: { type: 'raster', tiles: [url], tileSize: 256, minzoom: 4, maxzoom: 18, attribution } },
    layers: [{ id: `${src}-layer`, type: 'raster', source: src, paint: { 'raster-opacity': 0.85 } }],
    attribution,
  });
  switch (id) {
    case 'hiking_trails':
      return trails('overlay-hiking', ENDPOINTS.waymarkedHiking);
    case 'cycling_trails':
      return trails('overlay-cycling', ENDPOINTS.waymarkedCycling);
    case 'mtb_trails':
      return trails('overlay-mtb', ENDPOINTS.waymarkedMtb);
    case 'hillshade':
      return {
        sources: { 'overlay-dem': { type: 'raster-dem', tiles: [ENDPOINTS.terrainTiles], tileSize: 256, maxzoom: 15, encoding: 'terrarium', attribution } },
        layers: [
          {
            id: 'overlay-hillshade',
            type: 'hillshade',
            source: 'overlay-dem',
            paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#3b3f35', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#5b6050' },
          },
        ],
        attribution,
      };
  }
}

export interface ComposeOptions {
  /** Dim the map for night use (approximation: raster brightness + dark background). */
  dark?: boolean;
  /** Set explicitly to override the style name. */
  name?: string;
}

/**
 * Adds overlays to a base style (copy, input is not mutated). Overlay layers are
 * inserted below the first label (`symbol`) layer of vector styles so that
 * place names stay readable; on raster styles they go on top.
 */
export function composeStyle(base: StyleJson, overlays: readonly OverlayId[] = [], opts: ComposeOptions = {}): StyleJson {
  const style: StyleJson = JSON.parse(JSON.stringify(base)) as StyleJson;
  const seen = new Set<OverlayId>();
  const extraLayers: StyleLayer[] = [];
  // hillshade first so that trails lie on top of it
  const ordered = [...overlays].sort((a, b) => (a === 'hillshade' ? -1 : b === 'hillshade' ? 1 : 0));
  for (const id of ordered) {
    if (seen.has(id) || !OVERLAYS[id]) continue;
    seen.add(id);
    const p = overlayParts(id);
    Object.assign(style.sources, p.sources);
    extraLayers.push(...p.layers);
  }
  const firstSymbol = style.layers.findIndex((l) => l.type === 'symbol');
  if (firstSymbol >= 0) style.layers.splice(firstSymbol, 0, ...extraLayers);
  else style.layers.push(...extraLayers);
  if (opts.name) style.name = opts.name;
  if (opts.dark) applyDark(style);
  return style;
}

function applyDark(style: StyleJson): void {
  for (const l of style.layers) {
    l.paint = { ...(l.paint ?? {}) };
    if (l.type === 'raster') {
      l.paint['raster-brightness-max'] = 0.55;
      l.paint['raster-saturation'] = -0.25;
      l.paint['raster-contrast'] = 0.1;
    } else if (l.type === 'background') {
      l.paint['background-color'] = '#171b18';
    } else if (l.type === 'hillshade') {
      l.paint['hillshade-exaggeration'] = 0.2;
    } else if (l.type === 'fill' && typeof l.paint['fill-opacity'] !== 'object') {
      l.paint['fill-opacity'] = Math.min(1, Number(l.paint['fill-opacity'] ?? 1)) * 0.6;
    }
  }
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

export interface ResolveStyleOptions {
  mapyApiKey?: string;
  dark?: boolean;
  cache?: KeyValueCache;
  signal?: AbortSignal;
  /** Cache lifetime of the OpenFreeMap style JSON (default 7 days). */
  ttlMs?: number;
}

export interface ResolvedStyle {
  style: StyleJson;
  base: BaseStyleInfo;
  overlays: OverlayId[];
  /** true when OpenFreeMap could not be reached and the minimal raster fallback is used */
  fallback: boolean;
  /** Combined attribution text of base and overlays. */
  attribution: string;
  /** Czech notes for the UI. */
  warnings: string[];
}

/** Minimal raster style used when the vector style cannot be loaded and nothing is cached. */
export function fallbackRasterStyle(): StyleJson {
  return rasterStyle({
    id: 'fallback-osm',
    name: 'Záložní mapa',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    maxzoom: 19,
    attribution: `© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors`,
  });
}

/**
 * Loads (OpenFreeMap, cached – stale copy is used when offline) or builds the
 * style for `baseId` and merges the overlays. 'outdoor' always includes its
 * default overlays (hillshade, hiking trails).
 * @throws TrailPackError `not_configured` for Mapy.com styles without key.
 */
export async function resolveStyle(http: HttpClient, baseId: BaseStyleId, overlays: readonly OverlayId[] = [], opts: ResolveStyleOptions = {}): Promise<ResolvedStyle> {
  const base = BASE_STYLES[baseId];
  if (!base) throw new TrailPackError('invalid_input', `Neznámý styl mapy: ${String(baseId)}.`);
  const all = [...new Set<OverlayId>([...(baseId === 'outdoor' ? OUTDOOR_DEFAULT_OVERLAYS : []), ...overlays])];
  const warnings: string[] = [];
  let json: StyleJson;
  let fallback = false;
  const url = ofmStyleUrl(baseId);
  if (url) {
    try {
      const res = await cached(opts.cache, `mapstyle:${url}`, opts.ttlMs ?? 7 * 24 * 3600 * 1000, () => http.json<StyleJson>(url, { provider: 'openfreemap', signal: opts.signal }));
      if (!res.value || res.value.version !== 8 || !Array.isArray(res.value.layers) || !res.value.sources) {
        throw new TrailPackError('parse_error', 'Styl mapy má neplatný formát.', { provider: 'openfreemap' });
      }
      json = res.value;
      if (res.stale) warnings.push('Styl mapy pochází z mezipaměti (offline).');
    } catch (e) {
      if (e instanceof TrailPackError && e.code === 'aborted') throw e;
      json = fallbackRasterStyle();
      fallback = true;
      warnings.push('Vektorovou mapu se nepodařilo načíst, používá se záložní rastrová mapa.');
    }
  } else {
    json = rasterBaseStyle(baseId, opts.mapyApiKey);
  }
  const style = composeStyle(json, all, { dark: opts.dark, name: base.name });
  const attribution = [fallback ? '© přispěvatelé OpenStreetMap' : base.attribution, ...all.map((o) => OVERLAYS[o].attribution)].filter((v, i, a) => a.indexOf(v) === i).join(' · ');
  return { style, base, overlays: all, fallback, attribution, warnings };
}

// ---------------------------------------------------------------------------
// GeoJSON builders for the app's own layers
// ---------------------------------------------------------------------------

export interface Feature<G extends { type: string; coordinates: unknown } = { type: string; coordinates: unknown }> {
  type: 'Feature';
  id?: string | number;
  properties: Record<string, unknown>;
  geometry: G;
}
export interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}

/** Stage colours (color-blind friendly, readable on light and dark maps). */
export const DAY_COLORS: readonly string[] = ['#d1495b', '#00798c', '#edae49', '#66a182', '#30638e', '#8d5a97', '#e07a5f', '#3d405b'];

export interface RouteStageSpan {
  name?: string;
  /** Index into the geometry where the stage starts (inclusive). */
  fromIdx: number;
  /** Index where the stage ends (inclusive). */
  toIdx: number;
}

/**
 * Route line(s) for rendering. Without stages one feature `kind: 'route'`;
 * with stages one `kind: 'stage'` feature per stage (colour from DAY_COLORS)
 * plus `kind: 'stage_end'` points.
 */
export function routeFeatureCollection(geometry: readonly Position[], stages?: readonly RouteStageSpan[]): FeatureCollection {
  const features: Feature[] = [];
  if (!stages?.length) {
    if (geometry.length >= 2) {
      features.push({ type: 'Feature', properties: { kind: 'route', color: DAY_COLORS[0], distanceM: Math.round(lineLength(geometry)) }, geometry: { type: 'LineString', coordinates: geometry.map((p) => [...p]) } });
    }
    return { type: 'FeatureCollection', features };
  }
  stages.forEach((s, i) => {
    const from = Math.max(0, Math.min(geometry.length - 1, s.fromIdx));
    const to = Math.max(from, Math.min(geometry.length - 1, s.toIdx));
    const slice = geometry.slice(from, to + 1);
    if (slice.length < 2) return;
    const color = DAY_COLORS[i % DAY_COLORS.length]!;
    features.push({
      type: 'Feature',
      properties: { kind: 'stage', day: i + 1, name: s.name ?? `Den ${i + 1}`, color, distanceM: Math.round(lineLength(slice)) },
      geometry: { type: 'LineString', coordinates: slice.map((p) => [...p]) },
    });
    const end = slice[slice.length - 1]!;
    features.push({ type: 'Feature', properties: { kind: 'stage_end', day: i + 1, name: s.name ?? `Den ${i + 1}`, color }, geometry: { type: 'Point', coordinates: [end[0], end[1]] } });
  });
  return { type: 'FeatureCollection', features };
}

/** Water sources and campsites as point features (`kind: 'water' | 'camp'`). */
export function poiFeatureCollection(waters: readonly WaterSource[], campsites: readonly Campsite[]): FeatureCollection {
  const features: Feature[] = [
    ...waters.map(
      (w): Feature => ({
        type: 'Feature',
        id: w.id,
        properties: { kind: 'water', id: w.id, name: w.name ?? '', type: w.type, potability: w.potability, seasonal: w.seasonal ?? null, confidence: w.confidence },
        geometry: { type: 'Point', coordinates: w.eleM !== undefined ? [w.lon, w.lat, w.eleM] : [w.lon, w.lat] },
      }),
    ),
    ...campsites.map(
      (c): Feature => ({
        type: 'Feature',
        id: c.id,
        properties: { kind: 'camp', id: c.id, name: c.name ?? '', type: c.type, legalStatus: c.legalStatus, fee: c.fee ?? null },
        geometry: { type: 'Point', coordinates: c.eleM !== undefined ? [c.lon, c.lat, c.eleM] : [c.lon, c.lat] },
      }),
    ),
  ];
  return { type: 'FeatureCollection', features };
}

/** Route waypoints with a display label (`A`, `1`, `2`, …, last = `B`). */
export function waypointFeatureCollection(waypoints: readonly RouteWaypoint[]): FeatureCollection {
  const sorted = [...waypoints].sort((a, b) => a.order - b.order);
  return {
    type: 'FeatureCollection',
    features: sorted.map((w, i): Feature => ({
      type: 'Feature',
      id: w.id,
      properties: { kind: 'waypoint', id: w.id, order: w.order, type: w.type, name: w.name ?? '', label: i === 0 ? 'A' : i === sorted.length - 1 ? 'B' : String(i) },
      geometry: { type: 'Point', coordinates: [w.lon, w.lat] },
    })),
  };
}

/** A recorded GPS track as a line plus a `current` point at its end. */
export function trackFeatureCollection(points: readonly TrackPoint[]): FeatureCollection {
  const features: Feature[] = [];
  if (points.length >= 2) {
    features.push({ type: 'Feature', properties: { kind: 'track', pointCount: points.length }, geometry: { type: 'LineString', coordinates: points.map((p) => (p.ele !== undefined ? [p.lon, p.lat, p.ele] : [p.lon, p.lat])) } });
  }
  const last = points[points.length - 1];
  if (last) features.push({ type: 'Feature', properties: { kind: 'current', time: last.time ?? null, accuracy: last.accuracy ?? null }, geometry: { type: 'Point', coordinates: [last.lon, last.lat] } });
  return { type: 'FeatureCollection', features };
}

export type { BBox };
