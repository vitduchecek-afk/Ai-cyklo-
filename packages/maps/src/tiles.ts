/**
 * Slippy-map tile maths and offline region validation.
 * Tile scheme: XYZ (Web Mercator, y grows southwards), 256 px tiles.
 */
import type { BBox, Position } from '@trailpack/shared';
import { TrailPackError } from '@trailpack/shared';
import { bboxOf, bufferBBox } from '@trailpack/calculations';
import { BASE_STYLES } from './styles';
import type { BaseStyleId } from './styles';

export interface TileCoord {
  x: number;
  y: number;
  z: number;
}

/** Limit of Web Mercator in degrees latitude. */
export const MAX_MERCATOR_LAT = 85.0511287798;
/** Hard cap of tiles per offline region (storage + upstream politeness). */
export const MAX_OFFLINE_TILES = 60_000;

const clampLat = (lat: number) => Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));

/** Tile containing the point at zoom `z`. */
export function lonLatToTile(lon: number, lat: number, z: number): TileCoord {
  const n = 2 ** z;
  const latRad = (clampLat(lat) * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)), z };
}

/** North-west corner of a tile (fractional tile coordinates allowed). */
export function tileToLonLat(x: number, y: number, z: number): { lon: number; lat: number } {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lon, lat };
}

/** Tile x ranges covering a bbox (two ranges when the bbox crosses the antimeridian). */
function xRanges(w: number, e: number, z: number): Array<[number, number]> {
  if (w <= e) return [[lonLatToTile(w, 0, z).x, lonLatToTile(e, 0, z).x]];
  const max = 2 ** z - 1;
  return [
    [lonLatToTile(w, 0, z).x, max],
    [0, lonLatToTile(e, 0, z).x],
  ];
}

/** All tiles covering `bbox` at zoom `z`. Large inputs: check `countTiles` first. */
export function tilesInBBox(bbox: BBox, z: number): TileCoord[] {
  const [w, s, e, n] = bbox;
  const yMin = lonLatToTile(0, n, z).y;
  const yMax = lonLatToTile(0, s, z).y;
  const out: TileCoord[] = [];
  for (const [x0, x1] of xRanges(w, e, z)) {
    for (let x = x0; x <= x1; x++) for (let y = yMin; y <= yMax; y++) out.push({ x, y, z });
  }
  return out;
}

/** Number of tiles covering `bbox` for zoom levels `minZoom..maxZoom` (no allocation). */
export function countTiles(bbox: BBox, minZoom: number, maxZoom: number): number {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) total += countTilesAtZoom(bbox, z);
  return total;
}

function countTilesAtZoom(bbox: BBox, z: number): number {
  const [w, s, e, n] = bbox;
  const rows = lonLatToTile(0, s, z).y - lonLatToTile(0, n, z).y + 1;
  const cols = xRanges(w, e, z).reduce((a, [x0, x1]) => a + (x1 - x0 + 1), 0);
  return rows * cols;
}

/** Typical average tile payloads (bytes) for size estimates. */
export const AVG_TILE_BYTES = { vector: 30_000, raster: 25_000 } as const;

export interface OfflineSizeEstimate {
  tiles: number;
  bytes: number;
  perZoom: Array<{ z: number; tiles: number }>;
}

/** Rough download size of a region (average tile size × tile count). */
export function estimateOfflineSize(bbox: BBox, minZoom: number, maxZoom: number, kind: 'vector' | 'raster' = 'vector', avgTileBytes?: number): OfflineSizeEstimate {
  const perZoom: Array<{ z: number; tiles: number }> = [];
  let tiles = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const t = countTilesAtZoom(bbox, z);
    perZoom.push({ z, tiles: t });
    tiles += t;
  }
  return { tiles, bytes: tiles * (avgTileBytes ?? AVG_TILE_BYTES[kind]), perZoom };
}

export interface OfflineRegionRequest {
  styleId: BaseStyleId;
  bbox: BBox;
  minZoom: number;
  maxZoom: number;
}

export interface OfflineRegionValidation {
  ok: boolean;
  /** Czech messages describing every violated rule. */
  errors: string[];
  tileCount: number;
  estimatedBytes: number;
}

/**
 * Checks whether a region may be downloaded for offline use:
 * the style must permit it, zoom must stay ≤ the style's `maxOfflineZoom`
 * (vector: 14) and the region must not exceed 60 000 tiles.
 */
export function validateOfflineRegion(r: OfflineRegionRequest): OfflineRegionValidation {
  const errors: string[] = [];
  const style = BASE_STYLES[r.styleId];
  const [w, s, e, n] = r.bbox;
  if (!style) errors.push(`Neznámý styl mapy "${String(r.styleId)}".`);
  const geomOk = [w, s, e, n].every(Number.isFinite) && s >= -90 && n <= 90 && w >= -180 && e <= 180 && s < n;
  const zoomOk = Number.isInteger(r.minZoom) && Number.isInteger(r.maxZoom) && r.minZoom >= 0 && r.maxZoom <= 22 && r.minZoom <= r.maxZoom;
  if (!geomOk) errors.push('Neplatná oblast (bbox).');
  if (!zoomOk) errors.push('Neplatný rozsah úrovní přiblížení.');
  if (style) {
    if (!style.offlineAllowed) errors.push(`Styl „${style.name}“ nelze stahovat pro offline použití (podmínky poskytovatele dlaždic).`);
    else if (zoomOk && r.maxZoom > style.maxOfflineZoom) errors.push(`Nejvyšší offline přiblížení pro styl „${style.name}“ je ${style.maxOfflineZoom}.`);
  }
  let tileCount = 0;
  let estimatedBytes = 0;
  if (geomOk && zoomOk) {
    const est = estimateOfflineSize(r.bbox, r.minZoom, r.maxZoom, style?.kind ?? 'vector');
    tileCount = est.tiles;
    estimatedBytes = est.bytes;
    if (tileCount > MAX_OFFLINE_TILES) {
      errors.push(`Oblast je příliš velká (${tileCount.toLocaleString('cs-CZ')} dlaždic, maximum je ${MAX_OFFLINE_TILES.toLocaleString('cs-CZ')}). Zmenšete oblast nebo snižte přiblížení.`);
    }
  }
  return { ok: errors.length === 0, errors, tileCount, estimatedBytes };
}

/** Throws `invalid_input` / `unsupported` with the Czech messages when the region is not allowed. */
export function assertOfflineRegion(r: OfflineRegionRequest): OfflineRegionValidation {
  const v = validateOfflineRegion(r);
  if (!v.ok) {
    const notAllowed = !(BASE_STYLES[r.styleId]?.offlineAllowed ?? false);
    throw new TrailPackError(notAllowed ? 'unsupported' : 'invalid_input', v.errors.join(' '), { details: v });
  }
  return v;
}

/** Bounding box of a route with a buffer (meters) on every side. */
export function bboxForRoute(geometry: readonly Position[], bufferM = 1000): BBox {
  if (geometry.length === 0) throw new TrailPackError('invalid_input', 'Trasa je prázdná.');
  return bufferBBox(bboxOf(geometry), bufferM);
}
