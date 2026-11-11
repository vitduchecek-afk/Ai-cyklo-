/**
 * Valhalla (public OSM-DE instance, no key). Pedestrian and bicycle costing,
 * alternates, exclude areas and Czech turn-by-turn instructions.
 *
 * API: POST {base}/route with JSON `{locations, costing, costing_options, alternates, language, units: 'kilometers', elevation_interval}`.
 * Shapes are polyline6; elevation is returned per leg every `elevation_interval` meters
 * (starting at the leg start, last sample at the leg end).
 */
import { z } from 'zod';
import type { ActivityType, Position, RouteSegment } from '@trailpack/shared';
import { ENDPOINTS, HttpClient, TrailPackError, isCyclingActivity } from '@trailpack/shared';
import { cumulativeDistances, elevationStats } from '@trailpack/calculations';
import { buildSegments, circleRing, decodePolyline, mapRoutingError, mergeRuns, summarizeSurfaces } from './common';
import type { SegmentRun } from './common';
import { OSM_ATTRIBUTION } from './types';
import type { RouteResult, RoutingInstruction, RoutingProvider, RoutingRequest } from './types';

const ManeuverSchema = z
  .object({
    instruction: z.string().optional(),
    length: z.number().default(0),
    time: z.number().optional(),
    begin_shape_index: z.number().int().nonnegative(),
    end_shape_index: z.number().int().nonnegative(),
    travel_type: z.string().optional(),
  })
  .passthrough();
const LegSchema = z.object({
  shape: z.string(),
  maneuvers: z.array(ManeuverSchema).default([]),
  elevation: z.array(z.number()).optional(),
  elevation_interval: z.number().positive().optional(),
});
const TripSchema = z.object({
  legs: z.array(LegSchema).min(1),
  summary: z.object({ length: z.number(), time: z.number() }).passthrough(),
});
export const ValhallaResponseSchema = z.object({
  trip: TripSchema,
  alternates: z.array(z.object({ trip: TripSchema })).optional(),
});
export type ValhallaResponse = z.infer<typeof ValhallaResponseSchema>;

/** SAC hiking difficulty limit (0–6) per activity. */
function maxHikingDifficulty(activity: ActivityType): number {
  switch (activity) {
    case 'family':
      return 1;
    case 'day_hike':
      return 2;
    case 'ridge_traverse':
      return 4;
    default:
      return 3;
  }
}

function bicycleType(activity: ActivityType): 'Road' | 'Cross' | 'Mountain' | 'Hybrid' {
  switch (activity) {
    case 'road_cycling':
      return 'Road';
    case 'mtb':
    case 'xc':
      return 'Mountain';
    case 'gravel':
    case 'bikepacking':
      return 'Cross';
    default:
      return 'Hybrid';
  }
}

function useHills(pref: RoutingRequest['preference']): number {
  switch (pref) {
    case 'least_ascent':
    case 'easiest':
      return 0;
    case 'fastest':
      return 0.4;
    case 'scenic':
    case 'nature':
      return 0.7;
    default:
      return 0.5;
  }
}

/** Builds the JSON request body (exported for tests). */
export function buildValhallaRequest(req: RoutingRequest): Record<string, unknown> {
  const cycling = isCyclingActivity(req.activity);
  const costing = cycling ? 'bicycle' : 'pedestrian';
  const options: Record<string, unknown> = {};
  if (cycling) {
    options.bicycle_type = bicycleType(req.activity);
    options.use_hills = useHills(req.preference);
    if (req.surface === 'paved') options.avoid_bad_surfaces = 0.8;
    else if (req.surface === 'trail' || req.surface === 'avoid_paved') options.use_roads = 0;
    else if (req.preference === 'nature' || req.preference === 'scenic') options.use_roads = 0.2;
    if (req.preference === 'shortest') options.shortest = true;
  } else {
    options.max_hiking_difficulty = maxHikingDifficulty(req.activity);
    options.use_hills = useHills(req.preference);
    if (req.preference === 'shortest') options.shortest = true;
    if (req.preference === 'marked_trails' || req.preference === 'nature') options.use_trails = 1;
  }
  const body: Record<string, unknown> = {
    locations: req.waypoints.map((w, i) => ({ lat: w.lat, lon: w.lon, type: i === 0 || i === req.waypoints.length - 1 ? 'break' : 'through' })),
    costing,
    costing_options: { [costing]: options },
    directions_options: { units: 'kilometers', language: 'cs-CZ' },
    elevation_interval: 30,
  };
  if (req.alternatives && req.waypoints.length === 2) body.alternates = req.alternatives;
  if (req.avoid?.length) {
    body.exclude_polygons = req.avoid.map((a) => circleRing(a, a.radiusM));
  }
  return body;
}

/** Linear interpolation of `samples` (spaced `interval` m, last sample at `total`) at distance `d`. */
function sampleElevation(samples: readonly number[], interval: number, total: number, d: number): number {
  const n = samples.length;
  if (n === 1) return samples[0]!;
  const xs = (k: number) => (k >= n - 1 ? total : Math.min(k * interval, total));
  if (d <= 0) return samples[0]!;
  if (d >= total) return samples[n - 1]!;
  let k = Math.min(n - 2, Math.floor(d / interval));
  while (k < n - 2 && xs(k + 1) <= d) k++;
  const x0 = xs(k);
  const x1 = xs(k + 1);
  const t = x1 > x0 ? (d - x0) / (x1 - x0) : 0;
  return samples[k]! + (samples[k + 1]! - samples[k]!) * t;
}

/** Converts one Valhalla trip into a RouteResult (exported for tests). */
export function tripToRouteResult(trip: z.infer<typeof TripSchema>, profile: string): RouteResult {
  const geometry: Position[] = [];
  const instructions: RoutingInstruction[] = [];
  const runs: SegmentRun[] = [];
  let allEle = true;
  for (const leg of trip.legs) {
    const shape = decodePolyline(leg.shape, 6);
    if (shape.length < 2) throw new TrailPackError('parse_error', 'Odpověď Valhally neobsahuje geometrii trasy.', { provider: 'valhalla' });
    const offset = geometry.length === 0 ? 0 : geometry.length - 1; // legs share their joint vertex
    let withEle: Position[] = shape;
    if (leg.elevation?.length && leg.elevation_interval) {
      const cum = cumulativeDistances(shape);
      const total = cum[cum.length - 1] ?? 0;
      withEle = shape.map((p, i) => [p[0], p[1], Math.round(sampleElevation(leg.elevation!, leg.elevation_interval!, total, cum[i] ?? 0) * 10) / 10] as Position);
    } else {
      allEle = false;
    }
    geometry.push(...(geometry.length === 0 ? withEle : withEle.slice(1)));
    for (const m of leg.maneuvers) {
      if (m.instruction) instructions.push({ text: m.instruction, distanceM: Math.round(m.length * 1000), idx: m.begin_shape_index + offset });
      runs.push({ fromIdx: m.begin_shape_index + offset, toIdx: m.end_shape_index + offset, wayType: m.travel_type });
    }
  }
  const segments = buildSegments(geometry, mergeRuns(runs.filter((r) => r.toIdx > r.fromIdx)));
  const hasEle = allEle;
  const stats = hasEle ? elevationStats(geometry, 3) : { ascentM: 0, descentM: 0 };
  const warnings: string[] = [];
  if (!hasEle) warnings.push('Trasa neobsahuje nadmořské výšky; převýšení bude doplněno z výškového modelu.');
  return {
    geometry,
    distanceM: Math.round(trip.summary.length * 1000),
    ascentM: Math.round(stats.ascentM),
    descentM: Math.round(stats.descentM),
    durationS: Math.round(trip.summary.time),
    segments,
    surfaceSummary: {},
    instructions,
    provider: 'valhalla',
    profile,
    attribution: `Valhalla (OSM Germany) · ${OSM_ATTRIBUTION}`,
    warnings,
  };
}

/** One edge of a Valhalla `trace_attributes` response. */
export interface ValhallaTraceEdge {
  surface?: string;
  use?: string;
  road_class?: string;
  begin_shape_index: number;
  end_shape_index: number;
  length?: number;
}

/**
 * Derives segments (surface + way type) from `trace_attributes` edges and
 * returns them with a surface summary.
 */
export function segmentsFromTraceEdges(edges: readonly ValhallaTraceEdge[], geometry: readonly Position[]): { segments: RouteSegment[]; surfaceSummary: Record<string, number> } {
  const runs = mergeRuns(
    edges
      .filter((e) => e.end_shape_index > e.begin_shape_index)
      .map((e) => ({ fromIdx: e.begin_shape_index, toIdx: e.end_shape_index, surface: e.surface, wayType: e.use })),
  );
  const segments = buildSegments(geometry, runs);
  return { segments, surfaceSummary: summarizeSurfaces(segments) };
}

export class ValhallaProvider implements RoutingProvider {
  readonly id = 'valhalla' as const;
  readonly name = 'Valhalla';
  readonly requiresKey = false;
  readonly nativeLoop = false;

  /**
   * @param opts.fetchSurface when true, one extra `trace_attributes` request per route fills surface information.
   */
  constructor(
    private readonly http: HttpClient,
    private readonly opts: { baseUrl?: string; fetchSurface?: boolean } = {},
  ) {}

  supports(_activity: ActivityType): boolean {
    return true;
  }

  async route(req: RoutingRequest, signal?: AbortSignal): Promise<RouteResult[]> {
    const base = this.opts.baseUrl ?? ENDPOINTS.valhalla;
    const body = buildValhallaRequest(req);
    const profile = String(body.costing);
    let raw: unknown;
    try {
      raw = await this.http.json(`${base}/route`, { method: 'POST', body, provider: 'valhalla', signal, timeoutMs: 45_000 });
    } catch (e) {
      throw mapRoutingError(e, 'valhalla', /No path could be found|"error_code":\s*(?:442|171)|No suitable edges near location/i);
    }
    const parsed = ValhallaResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TrailPackError('parse_error', 'Odpověď Valhally má neočekávaný formát.', { provider: 'valhalla', details: parsed.error.issues.slice(0, 3) });
    }
    const trips = [parsed.data.trip, ...(parsed.data.alternates ?? []).map((a) => a.trip)];
    const results = trips.map((t) => tripToRouteResult(t, `${profile}${profile === 'bicycle' ? `:${String((body.costing_options as Record<string, Record<string, unknown>>).bicycle?.bicycle_type ?? '')}` : ''}`));
    if (this.opts.fetchSurface) {
      for (const r of results) await this.addSurface(base, r, profile, signal);
    }
    return results;
  }

  private async addSurface(base: string, r: RouteResult, costing: string, signal?: AbortSignal): Promise<void> {
    try {
      const shape = r.geometry.map((p) => ({ lat: p[1], lon: p[0] }));
      const res = await this.http.json<{ edges?: ValhallaTraceEdge[] }>(`${base}/trace_attributes`, {
        method: 'POST',
        provider: 'valhalla',
        signal,
        body: {
          shape,
          costing,
          shape_match: 'map_snap',
          filters: { attributes: ['edge.surface', 'edge.use', 'edge.road_class', 'edge.begin_shape_index', 'edge.end_shape_index', 'edge.length'], action: 'include' },
        },
      });
      if (res.edges?.length) {
        const { segments, surfaceSummary } = segmentsFromTraceEdges(res.edges, r.geometry);
        if (segments.length) {
          r.segments = segments;
          r.surfaceSummary = surfaceSummary;
        }
      }
    } catch (e) {
      if (e instanceof TrailPackError && e.code === 'aborted') throw e;
      r.warnings.push('Informace o povrchu se nepodařilo načíst.');
    }
  }
}
