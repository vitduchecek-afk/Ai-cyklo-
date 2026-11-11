/**
 * Offline connector: joins the waypoints with straight lines. Always available,
 * used when no routing service is reachable or the user draws a route by hand.
 */
import type { ActivityType } from '@trailpack/shared';
import { isCyclingActivity } from '@trailpack/shared';
import { cumulativeDistances } from '@trailpack/calculations';
import { buildSegments } from './common';
import type { RouteResult, RoutingProvider, RoutingRequest } from './types';

export const MANUAL_WARNING = 'Trasa není vypočtena po cestní síti (offline/ruční režim)';

export class ManualProvider implements RoutingProvider {
  readonly id = 'manual' as const;
  readonly name = 'Ruční trasa (přímé spojnice)';
  readonly requiresKey = false;
  readonly nativeLoop = false;

  supports(_activity: ActivityType): boolean {
    return true;
  }

  async route(req: RoutingRequest): Promise<RouteResult[]> {
    const geometry = req.waypoints.map((w): [number, number] => [w.lon, w.lat]);
    const cum = cumulativeDistances(geometry);
    const distanceM = Math.round(cum[cum.length - 1] ?? 0);
    // Straight lines are shorter than real paths; assume a 1.3× detour factor and typical speeds.
    const speedMs = (isCyclingActivity(req.activity) ? 15 : 4) / 3.6;
    return [
      {
        geometry,
        distanceM,
        ascentM: 0,
        descentM: 0,
        durationS: Math.round((distanceM * 1.3) / speedMs),
        segments: buildSegments(geometry, geometry.slice(1).map((_, i) => ({ fromIdx: i, toIdx: i + 1, wayType: 'straight' }))),
        surfaceSummary: { unknown: distanceM },
        provider: 'manual',
        profile: 'straight-line',
        attribution: '',
        warnings: [MANUAL_WARNING],
      },
    ];
  }
}
