import { describe, expect, it } from 'vitest';
import { MemoryCache, RouteSchema, TrailPackError } from '@trailpack/shared';
import { haversine } from '@trailpack/calculations';
import {
  BRouterProvider,
  ElevationService,
  GraphHopperProvider,
  ManualProvider,
  RoutingService,
  ValhallaProvider,
  compareRoutes,
  createDefaultProviders,
  routeToEntity,
} from '../src';
import type { RouteResult, RoutingProvider, RoutingRequest } from '../src';
import { fixture, fixtureText, jsonResponse, mockHttp } from './helpers';

const req: RoutingRequest = {
  waypoints: [
    { lat: 50.736, lon: 15.7397 },
    { lat: 50.73, lon: 15.74 },
  ],
  activity: 'hiking',
  preference: 'marked_trails',
};

/** Fake elevation endpoint: elevation = 1000 + 10000 × (lat − 50) so it varies smoothly. */
const elevationHandler = (c: { url: string }) => {
  if (!c.url.startsWith('https://api.open-meteo.com/v1/elevation')) return undefined;
  const lats = new URL(c.url).searchParams.get('latitude')!.split(',').map(Number);
  return jsonResponse({ elevation: lats.map((l) => Math.round((1000 + (l - 50) * 10000) * 10) / 10) });
};

describe('ElevationService', () => {
  const line = Array.from({ length: 1000 }, (_, i): [number, number] => [15 + i * 0.0001, 50 + i * 0.0001]);

  it('batches lookups by 100 and caches them', async () => {
    const cache = new MemoryCache();
    const { http, calls } = mockHttp(elevationHandler);
    const svc = new ElevationService({ http, cache });
    const pts = Array.from({ length: 250 }, (_, i) => ({ lat: 50 + i * 0.001, lon: 15 }));
    const e = await svc.lookup(pts);
    expect(e).toHaveLength(250);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => new URL(c.url).searchParams.get('latitude')!.split(',').length <= 100)).toBe(true);
    await svc.lookup(pts);
    expect(calls).toHaveLength(3); // served from cache
  });

  it('samples at most maxSamples points and interpolates', async () => {
    const { http, calls } = mockHttp(elevationHandler);
    const out = await new ElevationService({ http }).enrich(line, { maxSamples: 300 });
    const requested = calls.reduce((a, c) => a + new URL(c.url).searchParams.get('latitude')!.split(',').length, 0);
    expect(requested).toBeLessThanOrEqual(300);
    expect(calls).toHaveLength(3);
    expect(out).toHaveLength(1000);
    expect(out[0]![2]).toBeCloseTo(1000, 0);
    expect(out[500]![2]).toBeCloseTo(1000 + 10000 * 0.05, -1);
    expect(out[999]![2]).toBeCloseTo(1000 + 10000 * 0.0999, -1);
  });

  it('leaves complete 3D geometry alone and fails clearly when all values are missing', async () => {
    const { http, calls } = mockHttp();
    const svc = new ElevationService({ http });
    const g3: [number, number, number][] = [[1, 2, 3], [1.1, 2.1, 4]];
    expect(await svc.enrich(g3)).toEqual(g3);
    expect(calls).toHaveLength(0);
    await expect(svc.enrich([[1, 2], [1.1, 2.1]])).rejects.toBeInstanceOf(TrailPackError);
  });
});

describe('RoutingService', () => {
  it('routes through BRouter fixture, recomputes stats and caches', async () => {
    const { http, calls } = mockHttp(
      (c) => (c.url.includes('brouter.de') ? jsonResponse(fixtureText('brouter_hiking_krkonose.json')) : undefined),
    );
    const cache = new MemoryCache();
    const svc = new RoutingService({ http, cache, providers: createDefaultProviders({ http }) });
    const a = await svc.route(req);
    expect(a.usedProvider).toBe('brouter');
    expect(a.fallbackUsed).toBe(false);
    expect(a.results[0]!.distanceM).toBeGreaterThan(850);
    expect(a.results[0]!.distanceM).toBeLessThan(880);
    expect(a.fromCache).toBe(false);
    const b = await svc.route(req);
    expect(b.fromCache).toBe(true);
    expect(calls.filter((c) => c.url.includes('brouter.de'))).toHaveLength(1);
    // invalid request
    await expect(svc.route({ ...req, waypoints: [req.waypoints[0]!] })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('falls back to Valhalla on 5xx and enriches nothing when Valhalla already has elevation', async () => {
    const { http, calls } = mockHttp(
      (c) => (c.url.includes('brouter.de') ? new Response('Service Unavailable', { status: 503 }) : undefined),
      (c) => (c.url.includes('valhalla1') ? jsonResponse(fixtureText('valhalla_pedestrian.json')) : undefined),
    );
    const svc = new RoutingService({ http, providers: createDefaultProviders({ http }) });
    const out = await svc.route(req);
    expect(out.usedProvider).toBe('valhalla');
    expect(out.fallbackUsed).toBe(true);
    expect(out.attempts.map((a) => [a.provider, a.ok, a.errorCode])).toEqual([
      ['brouter', false, 'provider_error'],
      ['valhalla', true, undefined],
    ]);
    expect(out.results[0]!.warnings[0]).toContain('BRouter není dostupný');
    expect(calls.some((c) => c.url.includes('open-meteo'))).toBe(false);
    expect(out.results[0]!.ascentM + out.results[0]!.descentM).toBeGreaterThan(100);
  });

  it('skips providers without keys (not_configured) and enriches 2D results with elevation', async () => {
    const { http, calls } = mockHttp(
      elevationHandler,
      (c) => (c.url.includes('brouter.de') ? new Response('boom', { status: 500 }) : undefined),
      (c) => (c.url.includes('valhalla1') ? new Response('boom', { status: 502 }) : undefined),
      (c) =>
        c.url.includes('api.mapy.com')
          ? jsonResponse({
              length: 700,
              duration: 600,
              geometry: { type: 'LineString', coordinates: Array.from({ length: 20 }, (_, i) => [15.74, 50.73 + i * 0.0003]) },
            })
          : undefined,
    );
    const svc = new RoutingService({ http, providers: createDefaultProviders({ http, keys: { mapy: 'K' } }) });
    const out = await svc.route(req);
    expect(out.usedProvider).toBe('mapy');
    expect(out.attempts.map((a) => a.errorCode)).toEqual(['provider_error', 'provider_error', 'not_configured', 'not_configured', undefined]);
    const r = out.results[0]!;
    expect(r.geometry.every((p) => p.length === 3)).toBe(true);
    expect(r.ascentM).toBeGreaterThan(50); // 20 × 0.0003° ≈ 0.0057° ⇒ ≈ 57 m in the fake DEM
    expect(r.warnings.join(' ')).toContain('výškového modelu');
    expect(calls.some((c) => c.url.includes('open-meteo'))).toBe(true);
  });

  it('does not fall back on no_route, but reports not_configured when nothing is usable', async () => {
    const a = mockHttp(() => new Response('no track found at pass=1', { status: 200 }));
    const svc = new RoutingService({ http: a.http, providers: createDefaultProviders({ http: a.http }) });
    await expect(svc.route(req)).rejects.toMatchObject({ code: 'no_route' });
    expect(a.calls).toHaveLength(1);

    const b = mockHttp();
    const keyed = new RoutingService({ http: b.http, providers: [new GraphHopperProvider(b.http)], fallbackOrder: ['graphhopper'] });
    await expect(keyed.route(req)).rejects.toMatchObject({ code: 'not_configured' });

    const c = mockHttp(() => new Response('x', { status: 500 }));
    const down = new RoutingService({ http: c.http, providers: [new BRouterProvider(c.http), new ValhallaProvider(c.http)] });
    await expect(down.route(req)).rejects.toMatchObject({ code: 'provider_error' });
    await expect(down.route(req, { provider: 'brouter', noFallback: true })).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('honours an explicit provider and serves stale cache when everything fails', async () => {
    let fail = false;
    const { http, calls } = mockHttp(() => (fail ? new Response('x', { status: 500 }) : jsonResponse(fixtureText('valhalla_pedestrian.json'))));
    const cache = new MemoryCache();
    const svc = new RoutingService({ http, cache, providers: createDefaultProviders({ http }), cacheTtlMs: 1 });
    const first = await svc.route(req, { provider: 'valhalla' });
    expect(first.usedProvider).toBe('valhalla');
    expect(calls[0]!.url).toContain('valhalla1');
    await new Promise((r) => setTimeout(r, 5));
    fail = true;
    const second = await svc.route(req, { provider: 'valhalla' });
    expect(second.stale).toBe(true);
    expect(second.fromCache).toBe(true);
  });

  it('builds loops from circle waypoints for providers without native loops', async () => {
    const seen: RoutingRequest[] = [];
    const circleProvider: RoutingProvider = {
      id: 'brouter',
      name: 'Fake',
      requiresKey: false,
      supports: () => true,
      async route(r) {
        seen.push(r);
        const geometry = r.waypoints.map((w): [number, number, number] => [w.lon, w.lat, 500]);
        return [{ geometry, distanceM: 1, ascentM: 0, descentM: 0, segments: [], surfaceSummary: {}, provider: 'brouter', profile: 'x', attribution: '', warnings: [] }];
      },
    };
    const svc = new RoutingService({ http: mockHttp().http, providers: [circleProvider], elevation: null });
    const start = { lat: 50.1, lon: 14.4 };
    const out = await svc.loop({ start, lengthM: 20000, activity: 'hiking', preference: 'scenic', seed: 90 });
    expect(out.results[0]!.distanceM).toBeGreaterThan(10000);
    const wps = seen[0]!.waypoints;
    expect(wps).toHaveLength(5);
    expect(wps[0]).toEqual(start);
    expect(wps[4]).toEqual(start);
    // waypoints form a roughly circular ring: (20 km / 2π / 1.35) ≈ 2.4 km radius
    const radii = wps.slice(1, 4).map((w) => haversine(w, start));
    expect(Math.max(...radii)).toBeLessThan(6000);
    expect(Math.min(...radii)).toBeGreaterThan(1500);
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });

  it('prefers native round trips', async () => {
    const native: RoutingProvider = {
      id: 'openrouteservice',
      name: 'Fake ORS',
      requiresKey: true,
      nativeLoop: true,
      supports: () => true,
      async route(r) {
        expect(r.roundTrip).toEqual({ lengthM: 15000, seed: 7 });
        return [{ geometry: [[15, 50, 1], [15.1, 50.1, 2]], distanceM: 1, ascentM: 0, descentM: 0, segments: [], surfaceSummary: {}, provider: 'openrouteservice', profile: 'x', attribution: '', warnings: [] }];
      },
    };
    const other = new ManualProvider();
    const svc = new RoutingService({ http: mockHttp().http, providers: [other, native], elevation: null, fallbackOrder: ['manual', 'openrouteservice'] });
    const out = await svc.loop({ start: { lat: 50, lon: 15 }, lengthM: 15000, activity: 'mtb', preference: 'fastest', seed: 7 });
    expect(out.usedProvider).toBe('openrouteservice');
  });

  it('rejects results that fail validation', async () => {
    const bad: RoutingProvider = {
      id: 'brouter',
      name: 'Bad',
      requiresKey: false,
      supports: () => true,
      async route() {
        return [{ geometry: [[1, 2]], distanceM: -1, ascentM: 0, descentM: 0, segments: [], surfaceSummary: {}, provider: 'brouter', profile: 'x', attribution: '', warnings: [] } as RouteResult];
      },
    };
    const svc = new RoutingService({ http: mockHttp().http, providers: [bad], elevation: null });
    await expect(svc.route(req)).rejects.toMatchObject({ code: 'parse_error' });
  });
});

describe('compareRoutes / routeToEntity', () => {
  const mk = (over: Partial<RouteResult>): RouteResult => ({
    geometry: [[15, 50, 500], [15.01, 50.01, 600]],
    distanceM: 5000,
    ascentM: 100,
    descentM: 50,
    durationS: 4000,
    segments: [],
    surfaceSummary: {},
    provider: 'brouter',
    profile: 'hiking-mountain',
    attribution: 'x',
    warnings: [],
    ...over,
  });

  it('produces Czech pros and cons relative to other candidates', () => {
    const cmp = compareRoutes(
      [
        mk({ distanceM: 5000, ascentM: 300, durationS: 4000, surfaceSummary: { ground: 4000, gravel: 500, paved: 500 } }),
        mk({ distanceM: 6200, ascentM: 120, durationS: 4600, surfaceSummary: { paved: 5800, ground: 400 } }),
      ],
      { activity: 'hiking' },
    );
    expect(cmp.rows.map((r) => r.label)).toEqual(['Hlavní trasa', 'Alternativa 1']);
    expect(cmp.best).toMatchObject({ shortest: 0, leastAscent: 1, fastest: 0 });
    expect(cmp.rows[0]!.pros.join(' ')).toContain('Nejkratší');
    expect(cmp.rows[0]!.pros.join(' ')).toContain('přírodní povrch');
    expect(cmp.rows[0]!.cons.join(' ')).toContain('Nejvíce stoupání');
    expect(cmp.rows[1]!.pros.join(' ')).toContain('Nejmenší stoupání');
    expect(cmp.rows[1]!.cons.join(' ')).toContain('Nejdelší');
    expect(cmp.rows[1]!.cons.join(' ')).toContain('zpevněný');
  });

  it('converts a real BRouter result into a valid Route entity', async () => {
    const { http } = mockHttp(() => jsonResponse(fixtureText('brouter_hiking_krkonose.json')));
    const svc = new RoutingService({ http, providers: [new BRouterProvider(http)], elevation: null });
    const { results } = await svc.route(req);
    const route = routeToEntity(results[0]!, { name: 'Sněžka', activity: 'hiking', waypoints: [{ ...req.waypoints[0]!, name: 'Start' }, req.waypoints[1]!] });
    expect(RouteSchema.safeParse(route).success).toBe(true);
    expect(route.source).toBe('brouter');
    expect(route.waypoints.map((w) => w.type)).toEqual(['start', 'end']);
    expect(route.maxEleM).toBeGreaterThan(1500);
    expect(route.isLoop).toBe(false);
    expect(route.geometry).toHaveLength(49);
    expect(fixture('brouter_hiking_krkonose.json').features).toHaveLength(1);
  });
});
