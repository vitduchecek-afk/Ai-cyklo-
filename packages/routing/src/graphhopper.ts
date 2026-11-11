/**
 * GraphHopper Directions API (API key required, free tier). Alternative routes
 * (`algorithm: 'alternative_route'`) and round trips (`algorithm: 'round_trip'`).
 *
 * API: POST {base}/route?key=… with `points_encoded:false`, `elevation:true`, `details:['surface','road_class']`.
 * Detail entries are `[fromIdx, toIdx, value]`; `time` is milliseconds.
 */
import { z } from 'zod';
import type { ActivityType, Position } from '@trailpack/shared';
import { ENDPOINTS, HttpClient, TrailPackError, buildUrl } from '@trailpack/shared';
import { elevationStats } from '@trailpack/calculations';
import { buildSegments, mapRoutingError, mergeRuns, requireKey, summarizeSurfaces } from './common';
import type { SegmentRun } from './common';
import { OSM_ATTRIBUTION } from './types';
import type { RouteResult, RoutingInstruction, RoutingProvider, RoutingRequest } from './types';

const DetailSchema = z.array(z.tuple([z.number(), z.number(), z.unknown()]));
const PathSchema = z.object({
  distance: z.number(),
  time: z.number(),
  ascend: z.number().optional(),
  descend: z.number().optional(),
  points: z.object({ type: z.literal('LineString'), coordinates: z.array(z.array(z.number()).min(2)).min(2) }),
  instructions: z.array(z.object({ text: z.string(), distance: z.number(), interval: z.tuple([z.number(), z.number()]) }).passthrough()).optional(),
  details: z.object({ surface: DetailSchema.optional(), road_class: DetailSchema.optional() }).passthrough().optional(),
});
export const GraphHopperResponseSchema = z.object({ paths: z.array(PathSchema).min(1) });

/** GraphHopper profile for an activity. */
export function graphHopperProfileFor(activity: ActivityType): string {
  switch (activity) {
    case 'road_cycling':
      return 'racingbike';
    case 'mtb':
    case 'xc':
      return 'mtb';
    case 'gravel':
    case 'bikepacking':
      return 'bike';
    case 'family':
      return 'foot';
    default:
      return 'hike';
  }
}

/** Builds the GraphHopper request body (exported for tests). */
export function buildGraphHopperRequest(req: RoutingRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    points: req.waypoints.map((w) => [w.lon, w.lat]),
    profile: graphHopperProfileFor(req.activity),
    points_encoded: false,
    elevation: true,
    instructions: true,
    locale: 'cs',
    details: ['surface', 'road_class'],
    calc_points: true,
  };
  if (req.avoid?.length) {
    body['ch.disable'] = true;
    body.block_area = req.avoid.map((a) => `${a.lat},${a.lon},${Math.round(a.radiusM)}`).join(';');
  }
  if (req.roundTrip) {
    body.points = [[req.waypoints[0]!.lon, req.waypoints[0]!.lat]];
    body.algorithm = 'round_trip';
    body['ch.disable'] = true;
    body['round_trip.distance'] = Math.round(req.roundTrip.lengthM);
    if (req.roundTrip.seed !== undefined) body['round_trip.seed'] = req.roundTrip.seed;
  } else if (req.alternatives && req.waypoints.length === 2) {
    body.algorithm = 'alternative_route';
    body['ch.disable'] = true;
    body['alternative_route.max_paths'] = req.alternatives + 1;
  }
  return body;
}

/** Converts one GraphHopper path into a RouteResult (exported for tests). */
export function graphHopperPathToRoute(p: z.infer<typeof PathSchema>, profile: string): RouteResult {
  const geometry: Position[] = p.points.coordinates.map((c): Position => (c.length > 2 ? [c[0]!, c[1]!, c[2]!] : [c[0]!, c[1]!]));
  const last = geometry.length - 1;
  const surf = (p.details?.surface ?? []).map(([from, to, v]) => ({ from, to, v: String(v) }));
  const road = (p.details?.road_class ?? []).map(([from, to, v]) => ({ from, to, v: String(v) }));
  const cuts = new Set<number>([0, last]);
  for (const d of [...surf, ...road]) {
    cuts.add(Math.min(last, d.from));
    cuts.add(Math.min(last, d.to));
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const runs: SegmentRun[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i]!;
    const to = sorted[i + 1]!;
    runs.push({
      fromIdx: from,
      toIdx: to,
      surface: surf.find((s) => s.from <= from && s.to >= to)?.v,
      wayType: road.find((s) => s.from <= from && s.to >= to)?.v,
    });
  }
  const segments = buildSegments(geometry, mergeRuns(runs));
  const instructions: RoutingInstruction[] = (p.instructions ?? []).map((i) => ({ text: i.text, distanceM: Math.round(i.distance), idx: i.interval[0] }));
  const stats = geometry.every((g) => g.length > 2) ? elevationStats(geometry, 3) : { ascentM: 0, descentM: 0 };
  return {
    geometry,
    distanceM: Math.round(p.distance),
    ascentM: Math.round(p.ascend ?? stats.ascentM),
    descentM: Math.round(p.descend ?? stats.descentM),
    durationS: Math.round(p.time / 1000),
    segments,
    surfaceSummary: summarizeSurfaces(segments),
    instructions,
    provider: 'graphhopper',
    profile,
    attribution: `GraphHopper · ${OSM_ATTRIBUTION}`,
    warnings: [],
  };
}

export class GraphHopperProvider implements RoutingProvider {
  readonly id = 'graphhopper' as const;
  readonly name = 'GraphHopper';
  readonly requiresKey = true;
  readonly nativeLoop = true;

  constructor(
    private readonly http: HttpClient,
    private readonly opts: { apiKey?: string; baseUrl?: string } = {},
  ) {}

  supports(_activity: ActivityType): boolean {
    return true;
  }

  async route(req: RoutingRequest, signal?: AbortSignal): Promise<RouteResult[]> {
    const key = requireKey(this.opts.apiKey, 'graphhopper', 'GraphHopper');
    const body = buildGraphHopperRequest(req);
    let raw: unknown;
    try {
      raw = await this.http.json(buildUrl(`${this.opts.baseUrl ?? ENDPOINTS.graphHopper}/route`, { key }), {
        method: 'POST',
        body,
        provider: 'graphhopper',
        signal,
        timeoutMs: 45_000,
      });
    } catch (e) {
      throw mapRoutingError(e, 'graphhopper', /Connection between locations not found|Cannot find point|PointNotFound|ConnectionNotFound/i);
    }
    const parsed = GraphHopperResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TrailPackError('parse_error', 'Odpověď GraphHopper má neočekávaný formát.', { provider: 'graphhopper', details: parsed.error.issues.slice(0, 3) });
    }
    return parsed.data.paths.map((p) => graphHopperPathToRoute(p, String(body.profile)));
  }
}
