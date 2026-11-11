/**
 * BRouter (https://brouter.de) – free, no key, good hiking/cycling profiles and
 * full 3D geometry. Default provider.
 *
 * API: GET /brouter?lonlats=lon,lat|lon,lat&profile=…&alternativeidx=N&format=geojson[&nogos=lon,lat,radius|…]
 * Response: GeoJSON FeatureCollection; `properties` carry `track-length` (m), `filtered ascend` (m),
 * `total-time` (s) and a `messages` table (one row per way-tag change, coordinates in micro-degrees).
 */
import { z } from 'zod';
import type { ActivityType, Position } from '@trailpack/shared';
import { ENDPOINTS, HttpClient, TrailPackError, isCyclingActivity } from '@trailpack/shared';
import { elevationStats } from '@trailpack/calculations';
import { buildSegments, finite, mapRoutingError, mergeRuns, parseTagString, summarizeSurfaces } from './common';
import type { SegmentRun } from './common';
import { OSM_ATTRIBUTION } from './types';
import type { RouteResult, RoutingProvider, RoutingRequest } from './types';

const BRouterFeatureSchema = z.object({
  geometry: z.object({ type: z.literal('LineString'), coordinates: z.array(z.array(z.number()).min(2)).min(2) }),
  properties: z
    .object({
      'track-length': z.union([z.string(), z.number()]).optional(),
      'filtered ascend': z.union([z.string(), z.number()]).optional(),
      'total-time': z.union([z.string(), z.number()]).optional(),
      messages: z.array(z.array(z.string())).optional(),
    })
    .passthrough(),
});
const BRouterResponseSchema = z.object({ features: z.array(BRouterFeatureSchema).min(1) });

/** Profile names that exist on the public brouter.de server. */
export type BRouterProfile = 'hiking-mountain' | 'trekking' | 'mtb' | 'gravel' | 'fastbike' | 'shortest';

/**
 * Chooses the BRouter profile for an activity / preference.
 * Hiking-like activities → `hiking-mountain`; road cycling → `fastbike`;
 * MTB/XC → `mtb`; gravel → `gravel`; bikepacking → `trekking`; `shortest` preference on a bike → `shortest`.
 */
export function brouterProfileFor(activity: ActivityType, preference: RoutingRequest['preference']): BRouterProfile {
  if (!isCyclingActivity(activity)) return 'hiking-mountain';
  if (preference === 'shortest') return 'shortest';
  switch (activity) {
    case 'road_cycling':
      return 'fastbike';
    case 'mtb':
    case 'xc':
      return 'mtb';
    case 'gravel':
      return 'gravel';
    default:
      return preference === 'fastest' ? 'fastbike' : 'trekking';
  }
}

const NO_ROUTE_RE = /no track found|not mapped|datafile|target island|source island|island detected|no route|position not mapped/i;

const SAC_DEMANDING = new Set(['demanding_mountain_hiking', 'alpine_hiking', 'demanding_alpine_hiking', 'difficult_alpine_hiking']);

export class BRouterProvider implements RoutingProvider {
  readonly id = 'brouter' as const;
  readonly name = 'BRouter';
  readonly requiresKey = false;
  readonly nativeLoop = false;

  constructor(
    private readonly http: HttpClient,
    private readonly opts: { baseUrl?: string } = {},
  ) {}

  supports(_activity: ActivityType): boolean {
    return true;
  }

  async route(req: RoutingRequest, signal?: AbortSignal): Promise<RouteResult[]> {
    const profile = brouterProfileFor(req.activity, req.preference);
    const wanted = (req.alternatives ?? 0) + 1;
    const results: RouteResult[] = [];
    for (let i = 0; i < wanted; i++) {
      let res: RouteResult;
      try {
        res = await this.fetchOne(req, profile, i, signal);
      } catch (e) {
        // A missing alternative is not an error as long as the main route exists.
        if (i > 0 && e instanceof TrailPackError && (e.code === 'no_route' || e.code === 'invalid_input' || e.code === 'parse_error')) break;
        throw e;
      }
      if (results.some((r) => Math.abs(r.distanceM - res.distanceM) < 1 && r.geometry.length === res.geometry.length)) continue;
      results.push(res);
    }
    return results;
  }

  private async fetchOne(req: RoutingRequest, profile: BRouterProfile, altIdx: number, signal?: AbortSignal): Promise<RouteResult> {
    const lonlats = req.waypoints.map((w) => `${w.lon.toFixed(6)},${w.lat.toFixed(6)}`).join('%7C');
    let url = `${this.opts.baseUrl ?? ENDPOINTS.brouter}?lonlats=${lonlats}&profile=${profile}&alternativeidx=${altIdx}&format=geojson`;
    if (req.avoid?.length) {
      url += `&nogos=${req.avoid.map((a) => `${a.lon.toFixed(6)},${a.lat.toFixed(6)},${Math.round(a.radiusM)}`).join('%7C')}`;
    }
    let text: string;
    try {
      text = await this.http.text(url, { provider: 'brouter', signal, headers: { Accept: 'application/json' }, timeoutMs: 45_000 });
    } catch (e) {
      throw mapRoutingError(e, 'brouter', NO_ROUTE_RE);
    }
    return parseBRouterResponse(text, profile);
  }
}

/**
 * Parses a BRouter GeoJSON response body (exported for tests and offline fixtures).
 * @throws TrailPackError `no_route` for BRouter's plain-text errors, `parse_error` for malformed bodies.
 */
export function parseBRouterResponse(text: string, profile: string): RouteResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) {
    if (NO_ROUTE_RE.test(trimmed)) {
      throw new TrailPackError('no_route', 'Mezi zadanými body se nepodařilo najít trasu. Zkuste posunout body blíže k cestě.', { provider: 'brouter', details: trimmed.slice(0, 300) });
    }
    throw new TrailPackError('provider_error', `BRouter vrátil chybu: ${trimmed.slice(0, 200)}`, { provider: 'brouter' });
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (e) {
    throw new TrailPackError('parse_error', 'Odpověď BRouteru není platný JSON.', { provider: 'brouter', cause: e });
  }
  const parsed = BRouterResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new TrailPackError('parse_error', 'Odpověď BRouteru má neočekávaný formát.', { provider: 'brouter', details: parsed.error.issues.slice(0, 3) });
  }
  const feature = parsed.data.features[0]!;
  const geometry: Position[] = feature.geometry.coordinates.map((c): Position => (c.length > 2 ? [c[0]!, c[1]!, c[2]!] : [c[0]!, c[1]!]));
  const props = feature.properties;
  const warnings: string[] = [];

  const runs: SegmentRun[] = [];
  let accessIssueM = 0;
  let demandingM = 0;
  const messages = props.messages ?? [];
  const header = messages[0];
  if (header && messages.length > 1) {
    const col = (name: string) => header.indexOf(name);
    const cLon = col('Longitude');
    const cLat = col('Latitude');
    const cDist = col('Distance');
    const cTags = col('WayTags');
    // geometry coordinate → index lookup (micro-degree keys)
    const key = (lon: number, lat: number) => `${Math.round(lon * 1e6)},${Math.round(lat * 1e6)}`;
    const lookup = new Map<string, number[]>();
    geometry.forEach((p, i) => {
      const k = key(p[0], p[1]);
      const arr = lookup.get(k);
      if (arr) arr.push(i);
      else lookup.set(k, [i]);
    });
    let prevIdx = 0;
    for (const row of messages.slice(1)) {
      const lon = Number(row[cLon]) / 1e6;
      const lat = Number(row[cLat]) / 1e6;
      const dist = Number(row[cDist]);
      const tags = parseTagString(row[cTags] ?? '');
      const candidates = lookup.get(key(lon, lat));
      const idx = candidates?.find((i) => i > prevIdx) ?? (row === messages[messages.length - 1] ? geometry.length - 1 : undefined);
      if (idx === undefined || !Number.isFinite(lon)) continue;
      runs.push({ fromIdx: prevIdx, toIdx: idx, surface: tags.surface, wayType: tags.highway });
      if (tags.access === 'no' || tags.access === 'private' || tags.foot === 'no') accessIssueM += Number.isFinite(dist) ? dist : 0;
      if (tags.sac_scale && SAC_DEMANDING.has(tags.sac_scale)) demandingM += Number.isFinite(dist) ? dist : 0;
      prevIdx = idx;
    }
    // Make sure the runs cover the whole geometry (the last message ends at the target).
    if (runs.length && prevIdx < geometry.length - 1) runs[runs.length - 1]!.toIdx = geometry.length - 1;
  }
  const segments = buildSegments(geometry, mergeRuns(runs));

  const stats = elevationStats(geometry, 3);
  const hasEle = geometry.every((p) => p.length > 2);
  const trackLength = finite(props['track-length']);
  const filteredAscend = finite(props['filtered ascend']);
  const ascent = filteredAscend ?? stats.ascentM;
  const net = hasEle && stats.startEleM !== undefined && stats.endEleM !== undefined ? stats.endEleM - stats.startEleM : 0;
  const descent = hasEle ? Math.max(0, ascent - net) : 0;

  if (accessIssueM > 20) {
    warnings.push(`Trasa vede asi ${Math.round(accessIssueM)} m po úseku s omezeným nebo zakázaným přístupem (access=no/private). Ověřte si místní podmínky.`);
  }
  if (demandingM > 20) {
    warnings.push(`Trasa vede asi ${Math.round(demandingM)} m náročným alpským terénem (SAC T3 a více). Vyžaduje zkušenosti a vhodné vybavení.`);
  }

  return {
    geometry,
    distanceM: trackLength ?? segments.reduce((a, s) => a + s.distanceM, 0),
    ascentM: Math.round(ascent),
    descentM: Math.round(descent),
    durationS: finite(props['total-time']),
    segments,
    surfaceSummary: summarizeSurfaces(segments),
    provider: 'brouter',
    profile,
    attribution: `BRouter · ${OSM_ATTRIBUTION}`,
    warnings,
  };
}
