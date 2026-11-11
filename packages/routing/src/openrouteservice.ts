/**
 * openrouteservice.org (API key required, free tier). Native round trips,
 * alternative routes, avoid polygons, elevation and surface / waytype extras.
 *
 * API: POST {base}/v2/directions/{profile}/geojson, `Authorization: <key>`.
 * Extras (`surface`, `waytypes`) are lists of `[fromIdx, toIdx, code]`.
 */
import { z } from 'zod';
import type { ActivityType, Position } from '@trailpack/shared';
import { ENDPOINTS, HttpClient, TrailPackError } from '@trailpack/shared';
import { elevationStats } from '@trailpack/calculations';
import { buildSegments, circleRing, mapRoutingError, mergeRuns, requireKey, summarizeSurfaces } from './common';
import type { SegmentRun } from './common';
import { OSM_ATTRIBUTION } from './types';
import type { RouteResult, RoutingInstruction, RoutingProvider, RoutingRequest } from './types';

/** ORS surface codes → OSM-like surface value. */
const ORS_SURFACE: Record<number, string> = {
  0: 'unknown',
  1: 'paved',
  2: 'unpaved',
  3: 'asphalt',
  4: 'concrete',
  5: 'cobblestone',
  6: 'metal',
  7: 'wood',
  8: 'compacted',
  9: 'fine_gravel',
  10: 'gravel',
  11: 'dirt',
  12: 'ground',
  13: 'ice',
  14: 'paving_stones',
  15: 'sand',
  16: 'woodchips',
  17: 'grass',
  18: 'grass_paver',
};
/** ORS waytype codes. */
const ORS_WAYTYPE: Record<number, string> = {
  0: 'unknown',
  1: 'state_road',
  2: 'road',
  3: 'street',
  4: 'path',
  5: 'track',
  6: 'cycleway',
  7: 'footway',
  8: 'steps',
  9: 'ferry',
  10: 'construction',
};

const ExtraSchema = z.object({ values: z.array(z.tuple([z.number(), z.number(), z.number()])) });
const FeatureSchema = z.object({
  geometry: z.object({ type: z.literal('LineString'), coordinates: z.array(z.array(z.number()).min(2)).min(2) }),
  properties: z
    .object({
      summary: z.object({ distance: z.number(), duration: z.number() }),
      ascent: z.number().optional(),
      descent: z.number().optional(),
      segments: z
        .array(
          z.object({
            steps: z
              .array(z.object({ instruction: z.string(), distance: z.number(), way_points: z.tuple([z.number(), z.number()]) }).passthrough())
              .optional(),
          }),
        )
        .optional(),
      extras: z.object({ surface: ExtraSchema.optional(), waytypes: ExtraSchema.optional() }).passthrough().optional(),
    })
    .passthrough(),
});
export const OrsResponseSchema = z.object({ features: z.array(FeatureSchema).min(1) });

/** ORS profile for an activity. */
export function orsProfileFor(activity: ActivityType): string {
  switch (activity) {
    case 'road_cycling':
      return 'cycling-road';
    case 'mtb':
    case 'xc':
      return 'cycling-mountain';
    case 'gravel':
    case 'bikepacking':
      return 'cycling-regular';
    case 'family':
      return 'foot-walking';
    default:
      return 'foot-hiking';
  }
}

/** Builds the ORS request body (exported for tests). */
export function buildOrsRequest(req: RoutingRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    coordinates: req.waypoints.map((w) => [w.lon, w.lat]),
    elevation: true,
    instructions: true,
    language: 'cs',
    units: 'm',
    extra_info: ['surface', 'waytype'],
    preference: req.preference === 'shortest' ? 'shortest' : req.preference === 'fastest' ? 'fastest' : 'recommended',
  };
  const options: Record<string, unknown> = {};
  if (req.avoid?.length) {
    options.avoid_polygons = { type: 'MultiPolygon', coordinates: req.avoid.map((a) => [circleRing(a, a.radiusM)]) };
  }
  if (req.roundTrip) {
    body.coordinates = [[req.waypoints[0]!.lon, req.waypoints[0]!.lat]];
    options.round_trip = { length: Math.round(req.roundTrip.lengthM), points: 5, ...(req.roundTrip.seed !== undefined ? { seed: req.roundTrip.seed } : {}) };
  } else if (req.alternatives && req.waypoints.length === 2) {
    body.alternative_routes = { target_count: req.alternatives, share_factor: 0.6, weight_factor: 1.6 };
  }
  if (Object.keys(options).length) body.options = options;
  return body;
}

function expandExtra(values: ReadonlyArray<readonly [number, number, number]> | undefined, names: Record<number, string>): Array<{ from: number; to: number; name: string }> {
  return (values ?? []).map(([from, to, code]) => ({ from, to, name: names[code] ?? 'unknown' }));
}

/** Converts one ORS feature into a RouteResult (exported for tests). */
export function orsFeatureToRoute(f: z.infer<typeof FeatureSchema>, profile: string): RouteResult {
  const geometry: Position[] = f.geometry.coordinates.map((c): Position => (c.length > 2 ? [c[0]!, c[1]!, c[2]!] : [c[0]!, c[1]!]));
  const surf = expandExtra(f.properties.extras?.surface?.values, ORS_SURFACE);
  const ways = expandExtra(f.properties.extras?.waytypes?.values, ORS_WAYTYPE);
  // Sweep both extras into combined runs.
  const cuts = new Set<number>([0, geometry.length - 1]);
  for (const s of [...surf, ...ways]) {
    cuts.add(Math.min(geometry.length - 1, s.from));
    cuts.add(Math.min(geometry.length - 1, s.to));
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const runs: SegmentRun[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i]!;
    const to = sorted[i + 1]!;
    const surface = surf.find((s) => s.from <= from && s.to >= to)?.name;
    const wayType = ways.find((s) => s.from <= from && s.to >= to)?.name;
    runs.push({ fromIdx: from, toIdx: to, surface, wayType });
  }
  const segments = buildSegments(geometry, mergeRuns(runs));
  const instructions: RoutingInstruction[] = [];
  for (const seg of f.properties.segments ?? []) {
    for (const st of seg.steps ?? []) instructions.push({ text: st.instruction, distanceM: Math.round(st.distance), idx: st.way_points[0] });
  }
  const stats = geometry.every((p) => p.length > 2) ? elevationStats(geometry, 3) : { ascentM: 0, descentM: 0 };
  return {
    geometry,
    distanceM: Math.round(f.properties.summary.distance),
    ascentM: Math.round(f.properties.ascent ?? stats.ascentM),
    descentM: Math.round(f.properties.descent ?? stats.descentM),
    durationS: Math.round(f.properties.summary.duration),
    segments,
    surfaceSummary: summarizeSurfaces(segments),
    instructions,
    provider: 'openrouteservice',
    profile,
    attribution: `openrouteservice.org · ${OSM_ATTRIBUTION}`,
    warnings: [],
  };
}

export class OpenRouteServiceProvider implements RoutingProvider {
  readonly id = 'openrouteservice' as const;
  readonly name = 'openrouteservice';
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
    const key = requireKey(this.opts.apiKey, 'openrouteservice', 'openrouteservice');
    const profile = orsProfileFor(req.activity);
    let raw: unknown;
    try {
      raw = await this.http.json(`${this.opts.baseUrl ?? ENDPOINTS.openRouteService}/v2/directions/${profile}/geojson`, {
        method: 'POST',
        body: buildOrsRequest(req),
        headers: { Authorization: key, Accept: 'application/geo+json, application/json' },
        provider: 'openrouteservice',
        signal,
        timeoutMs: 45_000,
      });
    } catch (e) {
      throw mapRoutingError(e, 'openrouteservice', /"code":\s*(?:2010|2009|2004)|Could not find routable point|Route could not be found/i);
    }
    const parsed = OrsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TrailPackError('parse_error', 'Odpověď openrouteservice má neočekávaný formát.', { provider: 'openrouteservice', details: parsed.error.issues.slice(0, 3) });
    }
    return parsed.data.features.map((f) => orsFeatureToRoute(f, profile));
  }
}
