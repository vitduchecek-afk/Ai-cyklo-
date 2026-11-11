/**
 * Mapy.com routing (API key required). Excellent Czech hiking/cycling data.
 *
 * API: GET {base}/routing/route?start=lon,lat&end=lon,lat&waypoints=lon,lat&waypoints=lon,lat&routeType=…&format=geojson&lang=cs&apikey=…
 * The response carries `length` (m), `duration` (s) and a GeoJSON `geometry`
 * (Feature or bare geometry). No elevation is returned – the service enriches it.
 */
import type { ActivityType, Position } from '@trailpack/shared';
import { ENDPOINTS, HttpClient, TrailPackError, buildUrl } from '@trailpack/shared';
import { buildSegments, finite, mapRoutingError, requireKey } from './common';
import { OSM_ATTRIBUTION } from './types';
import type { RouteResult, RoutingProvider, RoutingRequest } from './types';

export type MapyRouteType = 'foot_hiking' | 'foot_fast' | 'bike_mountain' | 'bike_road' | 'car_fast';

/** Mapy.com routeType for an activity. */
export function mapyRouteTypeFor(activity: ActivityType, preference?: RoutingRequest['preference']): MapyRouteType {
  switch (activity) {
    case 'road_cycling':
      return 'bike_road';
    case 'mtb':
    case 'xc':
    case 'gravel':
    case 'bikepacking':
      return 'bike_mountain';
    default:
      return preference === 'fastest' ? 'foot_fast' : 'foot_hiking';
  }
}

function extractLine(geometryField: unknown): Position[] | undefined {
  let g = geometryField as { type?: string; geometry?: unknown; coordinates?: unknown } | undefined;
  for (let i = 0; i < 3 && g && typeof g === 'object'; i++) {
    if (g.type === 'LineString' && Array.isArray(g.coordinates)) {
      return (g.coordinates as unknown[]).flatMap((c): Position[] => {
        if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') return [];
        return typeof c[2] === 'number' ? [[c[0], c[1], c[2]]] : [[c[0], c[1]]];
      });
    }
    g = g.geometry as typeof g;
  }
  return undefined;
}

/** Converts a Mapy.com routing response (exported for tests). */
export function parseMapyResponse(raw: unknown, routeType: string): RouteResult {
  const r = raw as { length?: unknown; duration?: unknown; geometry?: unknown } | null;
  const geometry = r ? extractLine(r.geometry) : undefined;
  if (!geometry || geometry.length < 2) {
    throw new TrailPackError('parse_error', 'Odpověď Mapy.com neobsahuje geometrii trasy.', { provider: 'mapy' });
  }
  const length = finite(r?.length);
  const segments = buildSegments(geometry, [{ fromIdx: 0, toIdx: geometry.length - 1 }]);
  return {
    geometry,
    distanceM: Math.round(length ?? segments[0]?.distanceM ?? 0),
    ascentM: 0,
    descentM: 0,
    durationS: finite(r?.duration),
    segments,
    surfaceSummary: {},
    provider: 'mapy',
    profile: routeType,
    attribution: `© Seznam.cz a.s. a další · Mapy.com · ${OSM_ATTRIBUTION}`,
    warnings: ['Mapy.com nevrací nadmořské výšky; převýšení bude doplněno z výškového modelu.'],
  };
}

export class MapyProvider implements RoutingProvider {
  readonly id = 'mapy' as const;
  readonly name = 'Mapy.com';
  readonly requiresKey = true;
  readonly nativeLoop = false;

  constructor(
    private readonly http: HttpClient,
    private readonly opts: { apiKey?: string; baseUrl?: string } = {},
  ) {}

  supports(_activity: ActivityType): boolean {
    return true;
  }

  async route(req: RoutingRequest, signal?: AbortSignal): Promise<RouteResult[]> {
    const apikey = requireKey(this.opts.apiKey, 'mapy', 'Mapy.com');
    const routeType = mapyRouteTypeFor(req.activity, req.preference);
    const pt = (p: { lat: number; lon: number }) => `${p.lon},${p.lat}`;
    const first = req.waypoints[0]!;
    const last = req.waypoints[req.waypoints.length - 1]!;
    const via = req.waypoints.slice(1, -1);
    let url = buildUrl(`${this.opts.baseUrl ?? ENDPOINTS.mapy}/routing/route`, {
      start: pt(first),
      end: pt(last),
      routeType,
      format: 'geojson',
      lang: 'cs',
      apikey,
    });
    // `waypoints` is an array parameter: repeated once per via point (OpenAPI form/explode).
    for (const v of via) url += `&waypoints=${encodeURIComponent(pt(v))}`;
    let raw: unknown;
    try {
      raw = await this.http.json(url, { provider: 'mapy', signal, timeoutMs: 30_000 });
    } catch (e) {
      throw mapRoutingError(e, 'mapy', /route not found|no route|Unable to find/i);
    }
    const res = parseMapyResponse(raw, routeType);
    if (req.avoid?.length) res.warnings.push('Mapy.com nepodporuje vyhýbání se oblastem; požadavek byl ignorován.');
    if (req.alternatives) res.warnings.push('Mapy.com nenabízí alternativní trasy.');
    return [res];
  }
}
