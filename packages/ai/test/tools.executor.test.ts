import { describe, expect, it } from 'vitest';
import { compact, createToolExecutor } from '../src';
import type { ToolCallPart } from '../src';
import { makeFakePorts } from './tools.fakes';

const call = (name: string, args: Record<string, unknown>): ToolCallPart => ({ type: 'tool_call', id: `c-${name}`, name, arguments: args });
const WPS = [
  { lat: 49.5, lon: 18.3, name: 'A' },
  { lat: 49.6, lon: 18.7, name: 'B' },
];

describe('tool executor', () => {
  it('exposes exactly the specified tools with JSON schemas', () => {
    const ex = createToolExecutor(makeFakePorts());
    const defs = ex.definitions();
    expect(defs.map((d) => d.name).sort()).toEqual(
      [
        'searchLocations', 'geocodeLocation', 'calculateRoute', 'compareRoutes', 'getElevationProfile', 'getWeatherForecast', 'getWeatherAlongRoute',
        'searchCampsites', 'searchWaterSources', 'checkCampingRegulations', 'getGearInventory', 'calculatePackWeight', 'optimizeGear', 'calculateWaterNeeds',
        'calculateFoodNeeds', 'calculatePowerRequirements', 'createTrip', 'updateTrip', 'generateItinerary', 'prepareOfflineRegion', 'exportGPX',
        'getCurrentTrip', 'planExpedition',
      ].sort(),
    );
    for (const d of defs) {
      expect(d.parameters['$schema']).toBeUndefined();
      expect(d.parameters['type']).toBe('object');
      expect(d.description.length).toBeGreaterThan(30);
    }
    const route = defs.find((d) => d.name === 'calculateRoute')!;
    expect(Object.keys(route.parameters['properties'] as object)).toContain('waypoints');
    expect(createToolExecutor(makeFakePorts(), { enabled: ['getCurrentTrip'] }).definitions()).toHaveLength(1);
  });

  it('rejects invalid arguments with an issue summary and unknown tools', async () => {
    const ex = createToolExecutor(makeFakePorts());
    const bad = await ex.execute(call('getWeatherForecast', { lat: 120, lon: 'x' }));
    expect(bad.isError).toBe(true);
    expect((bad.content as { issues: string[] }).issues.join(' ')).toContain('lat');
    const unknown = await ex.execute(call('nope', {}));
    expect(unknown.isError).toBe(true);
    const aborted = new AbortController();
    aborted.abort();
    expect((await ex.execute(call('getCurrentTrip', {}), aborted.signal)).isError).toBe(true);
  });

  it('flags mutating tools and confirmation', () => {
    const ex = createToolExecutor(makeFakePorts());
    for (const n of ['createTrip', 'updateTrip', 'prepareOfflineRegion', 'planExpedition']) expect(ex.isMutating(n)).toBe(true);
    for (const n of ['calculateRoute', 'exportGPX', 'generateItinerary', 'getCurrentTrip']) expect(ex.isMutating(n)).toBe(false);
    expect(ex.needsConfirmation(call('createTrip', { name: 'X' }))).toBe(true);
    expect(ex.needsConfirmation(call('createTrip', {}))).toBe(false); // invalid -> fails at execute instead
    expect(ex.needsConfirmation(call('calculateRoute', { waypoints: WPS }))).toBe(false);
    expect(ex.describeCall(call('createTrip', { name: 'Beskydy' }))).toBe('Vytvořit výpravu „Beskydy“');
    expect(ex.describeCall(call('prepareOfflineRegion', { name: 'Beskydy', bbox: [18, 49, 19, 50] }))).toContain('offline mapy');
  });

  it('caches route geometry and returns only a short id + summary', async () => {
    const ports = makeFakePorts();
    const ex = createToolExecutor(ports);
    const r = await ex.execute(call('calculateRoute', { waypoints: [...WPS, { query: 'Radhošť' }], activity: 'hiking' }));
    expect(r.isError).toBeUndefined();
    const route = (r.content as { routes: { routeId: string; distanceKm: number; points: number }[] }).routes[0]!;
    expect(route.routeId).toMatch(/^rt/);
    expect(route.distanceKm).toBeGreaterThan(10);
    expect(JSON.stringify(r.content)).not.toContain('geometry');
    expect(JSON.stringify(r.content).length).toBeLessThan(800);
    expect(ex.routes.get(route.routeId)?.option.geometry.length).toBeGreaterThan(10);

    const second = await ex.execute(call('calculateRoute', { waypoints: WPS.slice().reverse(), alternatives: 2 }));
    const id2 = (second.content as { routes: { routeId: string }[] }).routes[0]!.routeId;
    expect(id2).not.toBe(route.routeId);

    const cmp = await ex.execute(call('compareRoutes', { routeIds: [route.routeId, id2], targetKm: 40 }));
    expect((cmp.content as { routes: unknown[] }).routes).toHaveLength(2);
    const prof = await ex.execute(call('getElevationProfile', { routeId: route.routeId, maxPoints: 10 }));
    expect((prof.content as { points: unknown[] }).points.length).toBeLessThanOrEqual(14);
    const wx = await ex.execute(call('getWeatherAlongRoute', { routeId: route.routeId, stageEndsIdx: [3, 9, 15] }));
    expect((wx.content as { samples: unknown[] }).samples).toHaveLength(3);
    const camps = await ex.execute(call('searchCampsites', { routeId: route.routeId }));
    expect(camps.isError).toBeUndefined();
    const water = await ex.execute(call('searchWaterSources', { routeId: route.routeId }));
    expect((water.content as { total: number }).total).toBe(3);

    const missing = await ex.execute(call('getElevationProfile', { routeId: 'rt999' }));
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain('calculateRoute');
  });

  it('exports GPX only for persisted routes and persists through createTrip', async () => {
    const ex = createToolExecutor(makeFakePorts());
    const r = await ex.execute(call('calculateRoute', { waypoints: WPS }));
    const id = (r.content as { routes: { routeId: string }[] }).routes[0]!.routeId;
    expect((await ex.execute(call('exportGPX', { routeId: id }))).isError).toBe(true);
    const created = await ex.execute(call('createTrip', { name: 'Test', routeId: id }));
    expect(created.content).toMatchObject({ tripId: 'trip1', savedRouteId: 'saved-trip1' });
    const gpx = await ex.execute(call('exportGPX', { routeId: id }));
    expect(gpx.content).toMatchObject({ fileName: 'saved-trip1.gpx', bytes: 1234 });
    expect((await ex.execute(call('exportGPX', {}))).isError).toBe(true);
  });

  it('checkCampingRegulations resolves country and protected areas first', async () => {
    const ports = makeFakePorts();
    const ex = createToolExecutor(ports);
    const r = await ex.execute(call('checkCampingRegulations', { lat: 49.5, lon: 18.5, sleepType: 'tent', campfire: false }));
    expect(r.content).toMatchObject({ countryCode: 'CZ', overall: 'conditional', disclaimer: expect.any(String) });
    expect(ports.calls['country']).toBe(1);
    expect(ports.calls['areas']).toBe(1);
  });

  it('guards offline downloads and gear/calc tools', async () => {
    const offline = createToolExecutor(makeFakePorts({ online: false }));
    expect((await offline.execute(call('prepareOfflineRegion', { name: 'X', bbox: [18, 49, 19, 50] }))).isError).toBe(true);
    const ex = createToolExecutor(makeFakePorts({ baseWeightG: 4500 }));
    const off = await ex.execute(call('prepareOfflineRegion', { name: 'Beskydy', bbox: [18, 49, 19, 50] }));
    expect(off.content).toMatchObject({ regionId: 'reg1', estimated: true });
    const w = await ex.execute(call('calculatePackWeight', { loadoutId: 'l1', targetBaseWeightG: 4000 }));
    expect(w.content).toMatchObject({ baseWeightG: 4500, overTargetG: 500 });
    expect((await ex.execute(call('optimizeGear', { loadoutId: 'l1' }))).content).toMatchObject({ potentialSavingG: 600 });
    expect((await ex.execute(call('getGearInventory', {}))).content).toMatchObject({ totalItems: 1 });
    const food = await ex.execute(call('calculateFoodNeeds', { days: 3, distanceKmPerDay: 20, ascentMPerDay: 800 }));
    expect(food.content).toMatchObject({ estimated: true });
    expect((await ex.execute(call('geocodeLocation', { query: '49.5, 18.4' }))).content).toMatchObject({ parsedCoordinates: true });
    expect((await ex.execute(call('geocodeLocation', {}))).isError).toBe(true);
    expect((await ex.execute(call('getCurrentTrip', {}))).content).toMatchObject({ trip: null });
  });

  it('planExpedition asks for the region when missing and plans when present', async () => {
    const ex = createToolExecutor(makeFakePorts());
    const ask = await ex.execute(call('planExpedition', { request: 'Chci příští víkend na dvoudenní přechod, ale nechci zmoknout.' }));
    expect(ask.content).toMatchObject({ needsMoreInfo: true });
    const plan = await ex.execute(call('planExpedition', { request: 'Chci na čtyři dny přejít Beskydy. Denně maximálně 20 km, ve stanu, základní hmotnost pod 4 kg.' }));
    expect(plan.isError).toBeUndefined();
    const c = plan.content as { routeId: string; feasible: boolean; days: string[] };
    expect(c.routeId).toMatch(/^rt/);
    expect(c.days.length).toBe(4);
    expect(ex.routes.get(c.routeId)).toBeDefined();
  });
});

describe('compact', () => {
  it('rounds, caps and drops empty values but keeps provenance', () => {
    const out = compact({ lat: 49.123456789, x: 1.23456, n: null, list: Array.from({ length: 50 }, (_, i) => i), source: 'osm', retrievedAt: '2026-01-01T00:00:00Z' }) as Record<string, unknown>;
    expect(out['lat']).toBe(49.12346);
    expect(out['x']).toBe(1.23);
    expect('n' in out).toBe(false);
    expect((out['list'] as unknown[]).length).toBe(41);
    expect(out['source']).toBe('osm');
    expect(out['retrievedAt']).toBe('2026-01-01T00:00:00Z');
  });
});
