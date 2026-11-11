import { describe, expect, it } from 'vitest';
import { MemoryCache, TrailPackError, WaterSourceSchema, CampsiteSchema } from '@trailpack/shared';
import {
  BASE_STYLES,
  DAY_COLORS,
  MAX_OFFLINE_TILES,
  OVERLAYS,
  bboxForRoute,
  composeStyle,
  countTiles,
  estimateOfflineSize,
  lonLatToTile,
  poiFeatureCollection,
  rasterBaseStyle,
  rasterStyle,
  resolveStyle,
  routeFeatureCollection,
  tileToLonLat,
  tilesInBBox,
  trackFeatureCollection,
  validateOfflineRegion,
  waypointFeatureCollection,
  assertOfflineRegion,
} from '../src';
import type { StyleJson } from '../src';
import { fixture, jsonResponse, mockHttp } from './helpers';

describe('catalogue', () => {
  it('has the required styles with Czech names and offline policy', () => {
    expect(Object.keys(BASE_STYLES).sort()).toEqual(['light', 'mapy_aerial', 'mapy_basic', 'mapy_outdoor', 'mapy_winter', 'outdoor', 'satellite', 'standard', 'topo']);
    expect(BASE_STYLES.outdoor).toMatchObject({ kind: 'vector', offlineAllowed: true, maxOfflineZoom: 14 });
    expect(BASE_STYLES.topo.offlineAllowed).toBe(false);
    expect(BASE_STYLES.satellite.offlineAllowed).toBe(false);
    expect(BASE_STYLES.mapy_outdoor).toMatchObject({ requiresKey: true, offlineAllowed: false });
    expect(Object.keys(OVERLAYS).sort()).toEqual(['cycling_trails', 'hiking_trails', 'hillshade', 'mtb_trails']);
    expect(Object.values(BASE_STYLES).every((s) => s.name && s.attribution)).toBe(true);
  });
});

describe('style building', () => {
  const liberty = fixture<StyleJson>('openfreemap_liberty_trimmed.json');

  it('builds raster styles for topo, satellite and Mapy.com', () => {
    const topo = rasterBaseStyle('topo');
    expect(topo.sources.topo!.tiles![0]).toBe('https://tile.opentopomap.org/{z}/{x}/{y}.png');
    const sat = rasterBaseStyle('satellite');
    expect(sat.sources.satellite!.tiles![0]).toContain('tiles.maps.eox.at');
    const mapy = rasterBaseStyle('mapy_winter', 'K E Y');
    expect(mapy.sources.mapy_winter!.tiles![0]).toBe('https://api.mapy.com/v1/maptiles/winter/256/{z}/{x}/{y}?apikey=K%20E%20Y');
    expect(() => rasterBaseStyle('mapy_outdoor')).toThrowError(TrailPackError);
    expect(rasterStyle({ id: 'x', tiles: ['t'] }).layers.map((l) => l.type)).toEqual(['background', 'raster']);
  });

  it('composes overlays below labels without mutating the base', () => {
    const before = JSON.stringify(liberty);
    const s = composeStyle(liberty, ['hiking_trails', 'hillshade']);
    expect(JSON.stringify(liberty)).toBe(before);
    expect(s.sources['overlay-hiking']!.tiles![0]).toContain('waymarkedtrails.org/hiking');
    expect(s.sources['overlay-dem']).toMatchObject({ type: 'raster-dem', encoding: 'terrarium' });
    const ids = s.layers.map((l) => l.id);
    const firstSymbol = s.layers.findIndex((l) => l.type === 'symbol');
    expect(ids.indexOf('overlay-hillshade')).toBeLessThan(ids.indexOf('overlay-hiking-layer'));
    expect(ids.indexOf('overlay-hiking-layer')).toBeLessThan(firstSymbol);
    expect(s.layers.length).toBe(liberty.layers.length + 2);
  });

  it('dark mode dims rasters', () => {
    const s = composeStyle(rasterBaseStyle('topo'), [], { dark: true });
    expect(s.layers.find((l) => l.type === 'raster')!.paint!['raster-brightness-max']).toBe(0.55);
  });

  it('resolves the real OpenFreeMap style with outdoor overlays and caches it', async () => {
    const { http, calls } = mockHttp((c) => (c.url === 'https://tiles.openfreemap.org/styles/liberty' ? jsonResponse(liberty) : undefined));
    const cache = new MemoryCache();
    const r = await resolveStyle(http, 'outdoor', ['cycling_trails'], { cache });
    expect(r.fallback).toBe(false);
    expect(r.overlays).toEqual(['hillshade', 'hiking_trails', 'cycling_trails']);
    expect(r.style.sources.openmaptiles!.type).toBe('vector');
    expect(r.style.sources['overlay-cycling']).toBeTruthy();
    expect(r.attribution).toContain('OpenFreeMap');
    expect(r.attribution).toContain('Waymarked Trails');
    await resolveStyle(http, 'outdoor', [], { cache });
    expect(calls).toHaveLength(1);
    // standard / light map to bright / positron
    await resolveStyle(http, 'standard', [], { cache }).catch(() => undefined);
    await resolveStyle(http, 'light', [], { cache }).catch(() => undefined);
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['liberty', 'bright', 'positron']);
  });

  it('falls back to a minimal raster style and serves stale cache when offline', async () => {
    const down = mockHttp(() => new Response('x', { status: 503 }));
    const r = await resolveStyle(down.http, 'standard');
    expect(r.fallback).toBe(true);
    expect(r.style.layers.some((l) => l.type === 'raster')).toBe(true);
    expect(r.warnings[0]).toContain('záložní');

    const cache = new MemoryCache();
    await cache.set('mapstyle:https://tiles.openfreemap.org/styles/liberty', fixture('openfreemap_liberty_trimmed.json'), -1000);
    const stale = await resolveStyle(down.http, 'outdoor', [], { cache });
    expect(stale.fallback).toBe(false);
    expect(stale.warnings.join(' ')).toContain('mezipaměti');

    await expect(resolveStyle(down.http, 'mapy_aerial', [], {})).rejects.toMatchObject({ code: 'not_configured' });
    const mapy = await resolveStyle(down.http, 'mapy_aerial', [], { mapyApiKey: 'abc' });
    expect(mapy.style.sources.mapy_aerial!.tiles![0]).toContain('apikey=abc');
  });
});

describe('GeoJSON builders', () => {
  const line: Array<[number, number, number]> = Array.from({ length: 10 }, (_, i) => [15 + i * 0.01, 50 + i * 0.005, 500 + i]);

  it('routeFeatureCollection without and with stages', () => {
    const single = routeFeatureCollection(line);
    expect(single.features).toHaveLength(1);
    expect(single.features[0]!.properties.kind).toBe('route');
    const staged = routeFeatureCollection(line, [
      { fromIdx: 0, toIdx: 4, name: 'Den 1' },
      { fromIdx: 4, toIdx: 9 },
    ]);
    expect(staged.features.map((f) => f.properties.kind)).toEqual(['stage', 'stage_end', 'stage', 'stage_end']);
    expect(staged.features[0]!.properties.color).toBe(DAY_COLORS[0]);
    expect(staged.features[2]!.properties.color).toBe(DAY_COLORS[1]);
    expect(staged.features[2]!.properties.name).toBe('Den 2');
    expect((staged.features[0]!.geometry.coordinates as unknown[]).length).toBe(5);
  });

  it('poi, waypoint and track collections', () => {
    const now = new Date().toISOString();
    const base = { createdAt: now, updatedAt: now, deletedAt: null, source: { provider: 'openstreetmap', retrievedAt: now } };
    const water = WaterSourceSchema.parse({ id: 'w1', type: 'spring', lat: 50.1, lon: 15.1, ...base });
    const camp = CampsiteSchema.parse({ id: 'c1', type: 'campground', lat: 50.2, lon: 15.2, eleM: 700, ...base });
    const pois = poiFeatureCollection([water], [camp]);
    expect(pois.features.map((f) => f.properties.kind)).toEqual(['water', 'camp']);
    expect(pois.features[1]!.geometry.coordinates).toEqual([15.2, 50.2, 700]);
    const wps = waypointFeatureCollection([
      { id: 'b', order: 2, lat: 1, lon: 2, type: 'end' },
      { id: 'a', order: 0, lat: 3, lon: 4, type: 'start' },
      { id: 'm', order: 1, lat: 5, lon: 6, type: 'via' },
    ]);
    expect(wps.features.map((f) => f.properties.label)).toEqual(['A', '1', 'B']);
    const track = trackFeatureCollection([{ lat: 50, lon: 15, ele: 400, time: 1 }, { lat: 50.1, lon: 15.1 }]);
    expect(track.features.map((f) => f.properties.kind)).toEqual(['track', 'current']);
    expect(trackFeatureCollection([]).features).toEqual([]);
  });
});

describe('tiles', () => {
  it('converts between lon/lat and tiles', () => {
    expect(lonLatToTile(0, 0, 1)).toEqual({ x: 1, y: 1, z: 1 });
    expect(lonLatToTile(14.4378, 50.0755, 10)).toEqual({ x: 553, y: 346, z: 10 });
    const nw = tileToLonLat(553, 346, 10);
    expect(nw.lon).toBeLessThanOrEqual(14.4378);
    expect(nw.lat).toBeGreaterThanOrEqual(50.0755);
    const back = lonLatToTile(nw.lon + 1e-6, nw.lat - 1e-6, 10);
    expect(back).toMatchObject({ x: 553, y: 346 });
    expect(lonLatToTile(0, 89, 3).y).toBe(0);
  });

  it('enumerates and counts tiles consistently', () => {
    const bbox: [number, number, number, number] = [15.6, 50.7, 15.8, 50.8];
    for (const z of [5, 9, 12]) expect(tilesInBBox(bbox, z).length).toBe(countTiles(bbox, z, z));
    expect(countTiles(bbox, 5, 12)).toBe([5, 6, 7, 8, 9, 10, 11, 12].reduce((a, z) => a + tilesInBBox(bbox, z).length, 0));
    expect(tilesInBBox([-180, -80, 180, 80], 1)).toHaveLength(4);
    // antimeridian crossing
    expect(tilesInBBox([179, 0, -179, 1], 3).map((t) => t.x).sort()).toEqual([0, 0, 7, 7]);
    const est = estimateOfflineSize(bbox, 8, 12);
    expect(est.tiles).toBe(countTiles(bbox, 8, 12));
    expect(est.bytes).toBeGreaterThan(est.tiles * 1000);
    expect(est.perZoom).toHaveLength(5);
  });

  it('validates offline regions', () => {
    const small: [number, number, number, number] = [15.6, 50.7, 15.8, 50.8];
    expect(validateOfflineRegion({ styleId: 'outdoor', bbox: small, minZoom: 8, maxZoom: 14 })).toMatchObject({ ok: true, errors: [] });
    const topo = validateOfflineRegion({ styleId: 'topo', bbox: small, minZoom: 8, maxZoom: 12 });
    expect(topo.ok).toBe(false);
    expect(topo.errors[0]).toContain('nelze stahovat');
    expect(validateOfflineRegion({ styleId: 'mapy_outdoor', bbox: small, minZoom: 1, maxZoom: 5 }).ok).toBe(false);
    const zoom = validateOfflineRegion({ styleId: 'standard', bbox: small, minZoom: 8, maxZoom: 15 });
    expect(zoom.errors.join(' ')).toContain('14');
    const big = validateOfflineRegion({ styleId: 'standard', bbox: [10, 45, 20, 55], minZoom: 6, maxZoom: 14 });
    expect(big.ok).toBe(false);
    expect(big.tileCount).toBeGreaterThan(MAX_OFFLINE_TILES);
    expect(big.errors.join(' ')).toContain('příliš velká');
    expect(validateOfflineRegion({ styleId: 'standard', bbox: [1, 2, 0, 1], minZoom: 3, maxZoom: 2 }).errors).toHaveLength(2);
    expect(() => assertOfflineRegion({ styleId: 'satellite', bbox: small, minZoom: 1, maxZoom: 3 })).toThrow(TrailPackError);
    expect(assertOfflineRegion({ styleId: 'light', bbox: small, minZoom: 1, maxZoom: 3 }).ok).toBe(true);
  });

  it('computes a buffered bbox for a route', () => {
    const bb = bboxForRoute([[15, 50], [15.1, 50.1]], 1000);
    expect(bb[0]).toBeLessThan(15);
    expect(bb[1]).toBeLessThan(50);
    expect(bb[2]).toBeGreaterThan(15.1);
    expect(bb[3]).toBeGreaterThan(50.1);
    expect(bb[3] - 50.1).toBeCloseTo(1000 / 111_195, 3);
    expect(() => bboxForRoute([])).toThrow();
  });
});
