import { describe, expect, it } from 'vitest';
import { TrailPackError } from '@trailpack/shared';
import {
  BRouterProvider,
  GraphHopperProvider,
  ManualProvider,
  MapyProvider,
  OpenRouteServiceProvider,
  ValhallaProvider,
  brouterProfileFor,
  buildValhallaRequest,
  decodePolyline,
  mapyRouteTypeFor,
  normalizeSurface,
  segmentsFromTraceEdges,
  tripToRouteResult,
  ValhallaResponseSchema,
} from '../src';
import type { RoutingRequest } from '../src';
import { fixture, fixtureText, jsonResponse, mockHttp } from './helpers';

const baseReq: RoutingRequest = {
  waypoints: [
    { lat: 50.736, lon: 15.7397 },
    { lat: 50.73, lon: 15.74 },
  ],
  activity: 'hiking',
  preference: 'marked_trails',
};

describe('common', () => {
  it('decodes polyline5 and polyline6', () => {
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
    expect(pts[0]).toEqual([-120.2, 38.5]);
    expect(pts[2]![0]).toBeCloseTo(-126.453, 3);
    expect(pts[2]![1]).toBeCloseTo(43.252, 3);
  });
  it('normalizes surfaces', () => {
    expect(normalizeSurface('asphalt')).toBe('paved');
    expect(normalizeSurface('sett')).toBe('paving_stones');
    expect(normalizeSurface('fine_gravel')).toBe('gravel');
    expect(normalizeSurface('rock')).toBe('rock');
    expect(normalizeSurface(undefined)).toBe('unknown');
    expect(normalizeSurface('weird')).toBe('unknown');
  });
});

describe('BRouter', () => {
  it('maps activities to profiles', () => {
    expect(brouterProfileFor('hiking', 'fastest')).toBe('hiking-mountain');
    expect(brouterProfileFor('ridge_traverse', 'easiest')).toBe('hiking-mountain');
    expect(brouterProfileFor('road_cycling', 'fastest')).toBe('fastbike');
    expect(brouterProfileFor('mtb', 'marked_trails')).toBe('mtb');
    expect(brouterProfileFor('bikepacking', 'scenic')).toBe('trekking');
    expect(brouterProfileFor('gravel', 'scenic')).toBe('gravel');
    expect(brouterProfileFor('xc', 'shortest')).toBe('shortest');
  });

  it('parses the real Krkonoše fixture (3D geometry, messages → segments, surface)', async () => {
    const { http, calls } = mockHttp((c) => (c.url.includes('brouter') ? jsonResponse(fixtureText('brouter_hiking_krkonose.json')) : undefined));
    const [r] = await new BRouterProvider(http).route({ ...baseReq, avoid: [{ lat: 50.7, lon: 15.7, radiusM: 150 }] });
    const url = calls[0]!.url;
    expect(url).toContain('lonlats=15.739700,50.736000%7C15.740000,50.730000');
    expect(url).toContain('profile=hiking-mountain');
    expect(url).toContain('alternativeidx=0');
    expect(url).toContain('format=geojson');
    expect(url).toContain('nogos=15.700000,50.700000,150');
    expect(r!.provider).toBe('brouter');
    expect(r!.geometry).toHaveLength(49);
    expect(r!.geometry[0]).toEqual([15.738572, 50.736417, 1583.5]);
    expect(r!.distanceM).toBe(863);
    expect(r!.durationS).toBe(932);
    expect(r!.ascentM).toBe(18);
    expect(r!.descentM).toBeGreaterThan(100); // ascent − (end − start) elevation
    // segments cover the whole line, ordered, with OSM way tags
    const segs = r!.segments;
    expect(segs[0]!.fromIdx).toBe(0);
    expect(segs[segs.length - 1]!.toIdx).toBe(48);
    expect(segs.every((s, i) => i === 0 || s.fromIdx === segs[i - 1]!.toIdx)).toBe(true);
    expect(segs.some((s) => s.wayType === 'steps' && s.surface === 'rock')).toBe(true);
    expect(r!.surfaceSummary.rock).toBeGreaterThan(300);
    expect(r!.surfaceSummary.paving_stones).toBeGreaterThan(0);
    expect(Object.values(r!.surfaceSummary).reduce((a, b) => a + b, 0)).toBeCloseTo(863, -1);
    expect(r!.warnings.join(' ')).toContain('omezeným');
    expect(r!.attribution).toContain('OpenStreetMap');
  });

  it('returns alternatives from successive alternativeidx calls and skips duplicates', async () => {
    const { http, calls } = mockHttp((c) =>
      c.url.includes('alternativeidx=0')
        ? jsonResponse(fixtureText('brouter_hiking_krkonose.json'))
        : c.url.includes('alternativeidx=1')
          ? jsonResponse(fixtureText('brouter_prague_alt1.json'))
          : jsonResponse(fixtureText('brouter_prague_alt1.json')),
    );
    const res = await new BRouterProvider(http).route({ ...baseReq, alternatives: 2 });
    expect(calls).toHaveLength(3);
    expect(res).toHaveLength(2); // idx 2 duplicates idx 1
    expect(res[1]!.distanceM).toBe(1837);
    expect(res[1]!.ascentM).toBe(52);
  });

  it('maps BRouter plain-text failures to no_route and HTTP errors to provider errors', async () => {
    const noTrack = mockHttp(() => new Response('no track found at pass=1', { status: 200 }));
    await expect(new BRouterProvider(noTrack.http).route(baseReq)).rejects.toMatchObject({ code: 'no_route' });
    const notMapped = mockHttp(() => new Response('from-position not mapped in existing datafile', { status: 400 }));
    await expect(new BRouterProvider(notMapped.http).route(baseReq)).rejects.toMatchObject({ code: 'no_route' });
    const down = mockHttp(() => new Response('oops', { status: 503 }));
    await expect(new BRouterProvider(down.http).route(baseReq)).rejects.toMatchObject({ code: 'provider_error', status: 503 });
  });
});

describe('Valhalla', () => {
  it('builds pedestrian and bicycle requests', () => {
    const ped = buildValhallaRequest({ ...baseReq, activity: 'ridge_traverse', preference: 'least_ascent', alternatives: 1, avoid: [{ lat: 50, lon: 15, radiusM: 100 }] }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ped.costing).toBe('pedestrian');
    expect(ped.costing_options.pedestrian).toMatchObject({ max_hiking_difficulty: 4, use_hills: 0 });
    expect(ped.alternates).toBe(1);
    expect(ped.elevation_interval).toBe(30);
    expect(ped.exclude_polygons[0]).toHaveLength(17);
    const bike = buildValhallaRequest({ ...baseReq, activity: 'mtb', preference: 'fastest', surface: 'trail' }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(bike.costing).toBe('bicycle');
    expect(bike.costing_options.bicycle).toMatchObject({ bicycle_type: 'Mountain', use_roads: 0 });
  });

  it('parses the real pedestrian fixture with elevation and Czech instructions', async () => {
    const { http, calls } = mockHttp((c) => (c.url.endsWith('/route') ? jsonResponse(fixtureText('valhalla_pedestrian.json')) : undefined));
    const [r] = await new ValhallaProvider(http).route(baseReq);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body.costing).toBe('pedestrian');
    expect(r!.distanceM).toBe(763);
    expect(r!.durationS).toBe(707);
    expect(r!.geometry.length).toBeGreaterThan(40);
    expect(r!.geometry.every((p) => p.length === 3)).toBe(true);
    expect(r!.geometry[0]![2]).toBeCloseTo(1593.2, 1);
    expect(r!.geometry[r!.geometry.length - 1]![2]).toBeCloseTo(fixture('valhalla_pedestrian.json').trip.legs[0].elevation.at(-1), 1);
    expect(r!.descentM).toBeGreaterThan(r!.ascentM);
    expect(r!.instructions![0]).toMatchObject({ text: 'Jděte na jihovýchod.', idx: 0, distanceM: 104 });
    expect(r!.instructions!.at(-1)!.text).toContain('cíl');
    expect(r!.segments.length).toBeGreaterThan(1);
  });

  it('returns alternates from the bicycle fixture', async () => {
    const { http } = mockHttp(() => jsonResponse(fixtureText('valhalla_bicycle_alternates.json')));
    const res = await new ValhallaProvider(http).route({ ...baseReq, activity: 'mtb', alternatives: 1 });
    expect(res).toHaveLength(2);
    expect(res[0]!.distanceM).toBe(5248);
    expect(res[1]!.distanceM).toBe(5417);
    expect(res[0]!.profile).toBe('bicycle:Mountain');
    expect(res[0]!.instructions![0]!.text).toContain('Křižovnická');
  });

  it('turns trace_attributes edges into surface segments (real fixture)', () => {
    const trace = fixture('valhalla_pedestrian_trace.json');
    const trip = ValhallaResponseSchema.parse(fixture('valhalla_pedestrian.json')).trip;
    const geometry = tripToRouteResult(trip, 'pedestrian').geometry;
    const { segments, surfaceSummary } = segmentsFromTraceEdges(trace.edges, geometry);
    expect(segments[0]).toMatchObject({ fromIdx: 0, wayType: 'path' });
    expect(segments.some((s) => s.wayType === 'steps')).toBe(true);
    expect(surfaceSummary.paved).toBeGreaterThan(0);
    expect(Object.values(surfaceSummary).reduce((a, b) => a + b, 0)).toBeGreaterThan(500);
  });

  it('uses trace_attributes when fetchSurface is set', async () => {
    const { http, calls } = mockHttp(
      (c) => (c.url.endsWith('/trace_attributes') ? jsonResponse(fixtureText('valhalla_pedestrian_trace.json')) : undefined),
      () => jsonResponse(fixtureText('valhalla_pedestrian.json')),
    );
    const [r] = await new ValhallaProvider(http, { fetchSurface: true }).route(baseReq);
    expect(calls).toHaveLength(2);
    expect(Object.keys(r!.surfaceSummary).length).toBeGreaterThan(1);
  });

  it('maps "no path" errors', async () => {
    const { http } = mockHttp(() => jsonResponse({ error_code: 442, error: 'No path could be found for input', status_code: 400, status: 'Bad Request' }, 400));
    await expect(new ValhallaProvider(http).route(baseReq)).rejects.toMatchObject({ code: 'no_route' });
  });
});

const geoLine = [
  [15.7, 50.7, 800],
  [15.701, 50.701, 850],
  [15.702, 50.702, 830],
  [15.703, 50.703, 900],
];

describe('OpenRouteService', () => {
  it('requires a key', async () => {
    const { http, calls } = mockHttp();
    await expect(new OpenRouteServiceProvider(http).route(baseReq)).rejects.toMatchObject({ code: 'not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('posts the right body, sends Authorization and parses extras', async () => {
    const response = {
      features: [
        {
          geometry: { type: 'LineString', coordinates: geoLine },
          properties: {
            summary: { distance: 500, duration: 400 },
            ascent: 120,
            descent: 20,
            segments: [{ steps: [{ instruction: 'Jděte rovně', distance: 500, way_points: [0, 3] }] }],
            extras: { surface: { values: [[0, 2, 10], [2, 3, 3]] }, waytypes: { values: [[0, 3, 4]] } },
          },
        },
      ],
    };
    const { http, calls } = mockHttp(() => jsonResponse(response));
    const [r] = await new OpenRouteServiceProvider(http, { apiKey: 'K' }).route({ ...baseReq, alternatives: 1, avoid: [{ lat: 50, lon: 15, radiusM: 200 }] });
    const c = calls[0]!;
    expect(c.url).toBe('https://api.openrouteservice.org/v2/directions/foot-hiking/geojson');
    expect(c.headers.Authorization).toBe('K');
    expect(c.body.elevation).toBe(true);
    expect(c.body.extra_info).toEqual(['surface', 'waytype']);
    expect(c.body.alternative_routes.target_count).toBe(1);
    expect(c.body.options.avoid_polygons.type).toBe('MultiPolygon');
    expect(r).toMatchObject({ provider: 'openrouteservice', distanceM: 500, ascentM: 120, descentM: 20, durationS: 400 });
    expect(r!.segments.map((s) => s.surface)).toEqual(['gravel', 'asphalt']);
    expect(r!.segments[0]!.wayType).toBe('path');
    expect(r!.surfaceSummary.gravel).toBeGreaterThan(0);
    expect(r!.instructions![0]!.text).toBe('Jděte rovně');
  });

  it('uses native round trip', async () => {
    const { http, calls } = mockHttp(() => jsonResponse({ features: [{ geometry: { type: 'LineString', coordinates: geoLine }, properties: { summary: { distance: 1, duration: 1 } } }] }));
    await new OpenRouteServiceProvider(http, { apiKey: 'K' }).route({ ...baseReq, activity: 'road_cycling', roundTrip: { lengthM: 20000, seed: 3 } });
    expect(calls[0]!.url).toContain('cycling-road');
    expect(calls[0]!.body.coordinates).toHaveLength(1);
    expect(calls[0]!.body.options.round_trip).toMatchObject({ length: 20000, seed: 3 });
  });

  it('maps ORS no-route error', async () => {
    const { http } = mockHttp(() => jsonResponse({ error: { code: 2010, message: 'Could not find routable point within a radius of 350.0 meters' } }, 404));
    await expect(new OpenRouteServiceProvider(http, { apiKey: 'K' }).route(baseReq)).rejects.toMatchObject({ code: 'no_route' });
  });
});

describe('GraphHopper', () => {
  it('requires a key and parses paths with details', async () => {
    await expect(new GraphHopperProvider(mockHttp().http).route(baseReq)).rejects.toMatchObject({ code: 'not_configured' });
    const response = {
      paths: [
        {
          distance: 520.4,
          time: 380000,
          ascend: 100,
          descend: 30,
          points: { type: 'LineString', coordinates: geoLine },
          instructions: [{ text: 'Pokračujte rovně', distance: 520, interval: [0, 3] }],
          details: { surface: [[0, 1, 'asphalt'], [1, 3, 'ground']], road_class: [[0, 3, 'track']] },
        },
      ],
    };
    const { http, calls } = mockHttp(() => jsonResponse(response));
    const res = await new GraphHopperProvider(http, { apiKey: 'SECRET' }).route({ ...baseReq, activity: 'mtb', alternatives: 2 });
    expect(calls[0]!.url).toBe('https://graphhopper.com/api/1/route?key=SECRET');
    expect(calls[0]!.body).toMatchObject({ profile: 'mtb', points_encoded: false, elevation: true, algorithm: 'alternative_route', 'alternative_route.max_paths': 3 });
    expect(res[0]).toMatchObject({ distanceM: 520, durationS: 380, ascentM: 100, descentM: 30, profile: 'mtb' });
    expect(res[0]!.segments.map((s) => s.surface)).toEqual(['asphalt', 'ground']);
    expect(res[0]!.segments[0]!.wayType).toBe('track');
  });

  it('round trip and error mapping', async () => {
    const a = mockHttp(() => jsonResponse({ paths: [{ distance: 1, time: 1, points: { type: 'LineString', coordinates: geoLine } }] }));
    await new GraphHopperProvider(a.http, { apiKey: 'K' }).route({ ...baseReq, roundTrip: { lengthM: 5000 } });
    expect(a.calls[0]!.body).toMatchObject({ algorithm: 'round_trip', 'round_trip.distance': 5000 });
    expect(a.calls[0]!.body.points).toHaveLength(1);
    const b = mockHttp(() => jsonResponse({ message: 'Connection between locations not found' }, 400));
    await expect(new GraphHopperProvider(b.http, { apiKey: 'K' }).route(baseReq)).rejects.toMatchObject({ code: 'no_route' });
    const c = mockHttp(() => jsonResponse({ message: 'Invalid key' }, 401));
    await expect(new GraphHopperProvider(c.http, { apiKey: 'bad' }).route(baseReq)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('Mapy.com', () => {
  it('maps route types', () => {
    expect(mapyRouteTypeFor('hiking')).toBe('foot_hiking');
    expect(mapyRouteTypeFor('mtb')).toBe('bike_mountain');
    expect(mapyRouteTypeFor('road_cycling')).toBe('bike_road');
  });

  it('requires a key and builds the GET request', async () => {
    await expect(new MapyProvider(mockHttp().http).route(baseReq)).rejects.toMatchObject({ code: 'not_configured' });
    const { http, calls } = mockHttp(() => jsonResponse({ length: 600, duration: 500, geometry: { type: 'Feature', geometry: { type: 'LineString', coordinates: geoLine.map((c) => [c[0], c[1]]) }, properties: {} } }));
    const [r] = await new MapyProvider(http, { apiKey: 'MK' }).route({
      ...baseReq,
      waypoints: [baseReq.waypoints[0]!, { lat: 50.733, lon: 15.7399 }, baseReq.waypoints[1]!],
      alternatives: 1,
    });
    const u = new URL(calls[0]!.url);
    expect(u.origin + u.pathname).toBe('https://api.mapy.com/v1/routing/route');
    expect(u.searchParams.get('start')).toBe('15.7397,50.736');
    expect(u.searchParams.get('end')).toBe('15.74,50.73');
    expect(u.searchParams.getAll('waypoints')).toEqual(['15.7399,50.733']);
    expect(u.searchParams.get('routeType')).toBe('foot_hiking');
    expect(u.searchParams.get('lang')).toBe('cs');
    expect(u.searchParams.get('apikey')).toBe('MK');
    expect(r).toMatchObject({ provider: 'mapy', distanceM: 600, durationS: 500 });
    expect(r!.geometry[0]).toHaveLength(2);
    expect(r!.warnings.join(' ')).toContain('alternativní');
  });

  it('fails with parse_error on a body without geometry', async () => {
    const { http } = mockHttp(() => jsonResponse({ length: 1 }));
    await expect(new MapyProvider(http, { apiKey: 'K' }).route(baseReq)).rejects.toBeInstanceOf(TrailPackError);
  });
});

describe('Manual', () => {
  it('connects waypoints with straight lines and warns', async () => {
    const [r] = await new ManualProvider().route(baseReq);
    expect(r!.geometry).toEqual([[15.7397, 50.736], [15.74, 50.73]]);
    expect(r!.distanceM).toBeGreaterThan(600);
    expect(r!.provider).toBe('manual');
    expect(r!.warnings).toContain('Trasa není vypočtena po cestní síti (offline/ruční režim)');
  });
});
