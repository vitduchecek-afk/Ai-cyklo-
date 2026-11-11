/**
 * Provider-independent routing contracts. All geometry is GeoJSON order
 * `[lon, lat, ele?]` (WGS84, elevation in meters); distances are meters,
 * durations are seconds.
 */
import { z } from 'zod';
import {
  ActivityTypeSchema,
  LatLonSchema,
  PositionSchema,
  RoutePreferenceSchema,
  RouteSegmentSchema,
  RoutingProviderIdSchema,
  SurfacePreferenceSchema,
} from '@trailpack/shared';
import type { ActivityType, LatLon, Position, RouteSegment, RoutingProviderId } from '@trailpack/shared';

/** Provider ids incl. the offline `manual` connector. */
export const RoutingProviderKeySchema = z.union([RoutingProviderIdSchema, z.literal('manual')]);
export type RoutingProviderKey = z.infer<typeof RoutingProviderKeySchema>;

export const AvoidAreaSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Radius of the circular area to avoid, meters. */
  radiusM: z.number().positive().max(50_000),
});
export type AvoidArea = z.infer<typeof AvoidAreaSchema>;

export const RoutingRequestSchema = z.object({
  /** Start, optional via points, end. At least two points. */
  waypoints: z.array(LatLonSchema).min(2).max(50),
  activity: ActivityTypeSchema,
  preference: RoutePreferenceSchema,
  surface: SurfacePreferenceSchema.optional(),
  avoid: z.array(AvoidAreaSchema).max(20).optional(),
  /** Number of alternative routes in addition to the main one (0–2). */
  alternatives: z.number().int().min(0).max(2).optional(),
  /** Round trip from the first waypoint with the given approximate length. */
  roundTrip: z.object({ lengthM: z.number().min(1000).max(200_000), seed: z.number().int().optional() }).optional(),
});
export type RoutingRequest = z.infer<typeof RoutingRequestSchema>;

export const RoutingInstructionSchema = z.object({
  text: z.string(),
  distanceM: z.number().nonnegative(),
  /** Index into the route geometry where the instruction starts. */
  idx: z.number().int().nonnegative(),
});
export type RoutingInstruction = z.infer<typeof RoutingInstructionSchema>;

export const RouteResultSchema = z.object({
  geometry: z.array(PositionSchema).min(2),
  distanceM: z.number().nonnegative(),
  ascentM: z.number().nonnegative(),
  descentM: z.number().nonnegative(),
  durationS: z.number().nonnegative().optional(),
  segments: z.array(RouteSegmentSchema),
  /** Meters per surface category (paved, paving_stones, gravel, ground, rock, unknown). */
  surfaceSummary: z.record(z.string(), z.number()),
  instructions: z.array(RoutingInstructionSchema).optional(),
  provider: RoutingProviderKeySchema,
  /** Provider-specific profile / costing used, e.g. 'hiking-mountain'. */
  profile: z.string(),
  attribution: z.string(),
  /** Czech, user-facing notes. */
  warnings: z.array(z.string()),
});
export type RouteResult = Omit<z.infer<typeof RouteResultSchema>, 'geometry' | 'segments'> & {
  geometry: Position[];
  segments: RouteSegment[];
};

export interface RoutingProvider {
  readonly id: RoutingProviderKey;
  /** Human readable name (Czech/neutral). */
  readonly name: string;
  readonly requiresKey: boolean;
  /** Whether the provider can route this activity (and has its key, if needed it still reports true; `route` then throws `not_configured`). */
  supports(activity: ActivityType): boolean;
  /**
   * Computes the main route and up to `req.alternatives` alternatives.
   * @throws TrailPackError (`no_route`, `not_configured`, `rate_limited`, `network`, `parse_error`, …)
   */
  route(req: RoutingRequest, signal?: AbortSignal): Promise<RouteResult[]>;
}

export const OSM_ATTRIBUTION = '© přispěvatelé OpenStreetMap';

export type { ActivityType, LatLon, RoutingProviderId };
