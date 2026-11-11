/**
 * RoutingService: provider selection with fallback, request/response
 * validation, elevation enrichment, consistent statistics and caching.
 */
import type { ActivityType, KeyValueCache, LatLon, Position, Route, RouteWaypoint } from '@trailpack/shared';
import {
  HttpClient,
  RouteSchema,
  TrailPackError,
  cacheKey,
  cached,
  formatDistance,
  formatDuration,
  isCyclingActivity,
  newEntityBase,
  toTrailPackError,
  uuid,
} from '@trailpack/shared';
import { destinationPoint, elevationStats, haversine, lineLength } from '@trailpack/calculations';
import { BRouterProvider } from './brouter';
import { buildSegments } from './common';
import { ElevationService } from './elevationService';
import { GraphHopperProvider } from './graphhopper';
import { ManualProvider } from './manual';
import { MapyProvider } from './mapy';
import { OpenRouteServiceProvider } from './openrouteservice';
import { RoutingRequestSchema, RouteResultSchema } from './types';
import type { RouteResult, RoutingProvider, RoutingProviderKey, RoutingRequest } from './types';
import { ValhallaProvider } from './valhalla';

export interface RoutingServiceOptions {
  http: HttpClient;
  cache?: KeyValueCache;
  providers: RoutingProvider[];
  /** Elevation enrichment for 2D results. Default: Open-Meteo via `http`. Pass `null` to disable. */
  elevation?: ElevationService | null;
  /** Order in which providers are tried after the preferred one. Default: brouter, valhalla, openrouteservice, graphhopper, mapy. */
  fallbackOrder?: RoutingProviderKey[];
  /** Cache TTL for routes (default 24 h). */
  cacheTtlMs?: number;
  /** Also try the next provider when one reports `no_route` (default false). */
  fallbackOnNoRoute?: boolean;
}

export interface RouteOptions {
  /** Preferred provider; others are tried afterwards unless `noFallback`. */
  provider?: RoutingProviderKey;
  signal?: AbortSignal;
  noFallback?: boolean;
  forceRefresh?: boolean;
}

export interface RoutingAttempt {
  provider: RoutingProviderKey;
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface RoutingOutcome {
  results: RouteResult[];
  usedProvider: RoutingProviderKey;
  fallbackUsed: boolean;
  attempts: RoutingAttempt[];
  fromCache: boolean;
  /** true when the result is an expired cache entry served because every provider failed */
  stale: boolean;
}

export interface LoopRequest extends Omit<RoutingRequest, 'waypoints' | 'roundTrip'> {
  start: LatLon;
  /** Approximate loop length, meters. */
  lengthM: number;
  seed?: number;
}

const DEFAULT_ORDER: RoutingProviderKey[] = ['brouter', 'valhalla', 'openrouteservice', 'graphhopper', 'mapy'];
const FALLBACK_CODES = new Set(['network', 'offline', 'timeout', 'rate_limited', 'provider_error', 'not_configured', 'unauthorized', 'forbidden', 'parse_error', 'unsupported']);

/** Creates all built-in providers; keyed providers report `not_configured` until a key is supplied. */
export function createDefaultProviders(opts: {
  http: HttpClient;
  keys?: { openrouteservice?: string; graphhopper?: string; mapy?: string };
  valhallaSurface?: boolean;
}): RoutingProvider[] {
  const { http, keys = {} } = opts;
  return [
    new BRouterProvider(http),
    new ValhallaProvider(http, { fetchSurface: opts.valhallaSurface }),
    new OpenRouteServiceProvider(http, { apiKey: keys.openrouteservice }),
    new GraphHopperProvider(http, { apiKey: keys.graphhopper }),
    new MapyProvider(http, { apiKey: keys.mapy }),
    new ManualProvider(),
  ];
}

export class RoutingService {
  private readonly providers = new Map<RoutingProviderKey, RoutingProvider>();
  private readonly elevation: ElevationService | null;
  private readonly cache?: KeyValueCache;
  private readonly order: RoutingProviderKey[];
  private readonly ttl: number;
  private readonly fallbackOnNoRoute: boolean;

  constructor(opts: RoutingServiceOptions) {
    for (const p of opts.providers) this.providers.set(p.id, p);
    this.cache = opts.cache;
    this.elevation = opts.elevation === undefined ? new ElevationService({ http: opts.http, cache: opts.cache }) : opts.elevation;
    this.order = opts.fallbackOrder ?? DEFAULT_ORDER;
    this.ttl = opts.cacheTtlMs ?? 24 * 3600 * 1000;
    this.fallbackOnNoRoute = opts.fallbackOnNoRoute ?? false;
  }

  /** Ids of registered providers. */
  providerIds(): RoutingProviderKey[] {
    return [...this.providers.keys()];
  }

  /**
   * Computes a route (plus alternatives). Falls back to the next provider on
   * network errors, 5xx, rate limiting and missing API keys.
   * @throws TrailPackError `invalid_input`, `no_route`, or the most informative provider error.
   */
  async route(request: RoutingRequest, options: RouteOptions = {}): Promise<RoutingOutcome> {
    const parsed = RoutingRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new TrailPackError('invalid_input', 'Neplatný požadavek na trasu: zadejte alespoň dva platné body a typ aktivity.', { details: parsed.error.issues.slice(0, 5) });
    }
    const req = parsed.data;
    const run = () => this.attemptAll(options, req.activity, (p) => p.route(req, options.signal), req);
    // Random round trips must not be cached.
    if (req.roundTrip && req.roundTrip.seed === undefined) return run();
    const key = cacheKey('route:v1', { req, provider: options.provider, noFallback: options.noFallback });
    const res = await cached(this.cache, key, this.ttl, run, { forceRefresh: options.forceRefresh });
    return { ...res.value, fromCache: res.fromCache, stale: res.stale };
  }

  /**
   * Round trip from `start` of approximately `lengthM`. Uses the native round
   * trip of openrouteservice / GraphHopper when available, otherwise routes
   * through waypoints placed on a circle (one length correction pass).
   */
  async loop(request: LoopRequest, options: RouteOptions = {}): Promise<RoutingOutcome> {
    const seed = request.seed ?? Math.floor(Math.random() * 360);
    const base = { activity: request.activity, preference: request.preference, surface: request.surface, avoid: request.avoid, alternatives: request.alternatives };
    const nativeReq: RoutingRequest = { ...base, waypoints: [request.start, request.start], roundTrip: { lengthM: request.lengthM, seed } };
    const check = RoutingRequestSchema.safeParse(nativeReq);
    if (!check.success) throw new TrailPackError('invalid_input', 'Neplatný požadavek na okružní trasu (délka musí být 1–200 km).', { details: check.error.issues.slice(0, 5) });
    const order = this.candidateOrder(options, request.activity, true);
    return this.attemptAll(
      options,
      request.activity,
      async (p) => {
        if (p.nativeLoop) return p.route(nativeReq, options.signal);
        return this.circleLoop(p, request, base, seed, options.signal);
      },
      nativeReq,
      order,
    );
  }

  private async circleLoop(p: RoutingProvider, request: LoopRequest, base: Omit<RoutingRequest, 'waypoints' | 'roundTrip'>, seed: number, signal?: AbortSignal): Promise<RouteResult[]> {
    const DETOUR = 1.35; // road length ≈ circle circumference × detour
    let radius = request.lengthM / (2 * Math.PI * DETOUR);
    let best: RouteResult[] | undefined;
    for (let pass = 0; pass < 2; pass++) {
      const bearing = seed % 360;
      const center = destinationPoint(request.start, bearing, radius);
      const around = [90, 180, 270].map((d) => destinationPoint(center, (bearing + 180 + d) % 360, radius));
      const res = await p.route({ ...base, waypoints: [request.start, ...around, request.start] }, signal);
      best = res;
      const actual = res[0]?.distanceM ?? 0;
      if (actual <= 0 || Math.abs(actual - request.lengthM) / request.lengthM <= 0.2) break;
      radius *= Math.max(0.4, Math.min(2.5, request.lengthM / actual));
    }
    return best ?? [];
  }

  private candidateOrder(options: RouteOptions, activity: ActivityType, preferNativeLoop = false): RoutingProvider[] {
    const ids: RoutingProviderKey[] = [];
    if (options.provider) ids.push(options.provider);
    if (!options.noFallback || !options.provider) for (const id of this.order) if (!ids.includes(id)) ids.push(id);
    let list = ids.map((id) => this.providers.get(id)).filter((p): p is RoutingProvider => !!p && p.supports(activity));
    if (options.provider && !this.providers.has(options.provider)) {
      throw new TrailPackError('invalid_input', `Poskytovatel tras "${options.provider}" není k dispozici.`);
    }
    if (preferNativeLoop && !options.provider) list = [...list.filter((p) => p.nativeLoop), ...list.filter((p) => !p.nativeLoop)];
    return list;
  }

  private async attemptAll(
    options: RouteOptions,
    activity: ActivityType,
    call: (p: RoutingProvider) => Promise<RouteResult[]>,
    req: RoutingRequest,
    order?: RoutingProvider[],
  ): Promise<RoutingOutcome> {
    const candidates = order ?? this.candidateOrder(options, activity);
    if (candidates.length === 0) throw new TrailPackError('not_configured', 'Není nakonfigurován žádný poskytovatel tras.');
    const attempts: RoutingAttempt[] = [];
    const errors: TrailPackError[] = [];
    for (const [i, p] of candidates.entries()) {
      try {
        const raw = await call(p);
        const results = await this.finalize(raw, p, req, options.signal);
        if (results.length === 0) throw new TrailPackError('no_route', 'Poskytovatel nevrátil žádnou trasu.', { provider: p.id });
        attempts.push({ provider: p.id, ok: true });
        const fallbackUsed = i > 0;
        if (fallbackUsed) {
          const first = candidates[0]!;
          const note = `Trasa byla vypočtena službou ${p.name}, protože ${first.name} není dostupný.`;
          for (const r of results) r.warnings.unshift(note);
        }
        return { results, usedProvider: p.id, fallbackUsed, attempts, fromCache: false, stale: false };
      } catch (e) {
        const err = toTrailPackError(e, p.id);
        attempts.push({ provider: p.id, ok: false, errorCode: err.code, errorMessage: err.message });
        errors.push(err);
        if (err.code === 'aborted') throw err;
        const canFallback = FALLBACK_CODES.has(err.code) || (err.code === 'no_route' && this.fallbackOnNoRoute);
        if (!canFallback || options.noFallback) throw err;
      }
    }
    // Everything failed: surface the most informative error.
    const informative = errors.find((e) => e.code !== 'not_configured') ?? errors[0]!;
    if (errors.every((e) => e.code === 'not_configured')) throw informative;
    throw new TrailPackError(informative.code, informative.message, { provider: informative.provider, status: informative.status, details: { attempts }, cause: informative });
  }

  /** Validates, enriches with elevation and recomputes statistics. */
  private async finalize(raw: RouteResult[], p: RoutingProvider, req: RoutingRequest, signal?: AbortSignal): Promise<RouteResult[]> {
    const out: RouteResult[] = [];
    for (const r of raw) {
      const valid = RouteResultSchema.safeParse(r);
      if (!valid.success) {
        throw new TrailPackError('parse_error', `Výsledek trasy od ${p.name} je neplatný.`, { provider: p.id, details: valid.error.issues.slice(0, 3) });
      }
      let res: RouteResult = { ...r, warnings: [...r.warnings] };
      const complete = res.geometry.every((g) => g.length > 2);
      if (!complete && this.elevation && p.id !== 'manual') {
        try {
          const geometry = await this.elevation.enrich(res.geometry, { signal });
          res = { ...res, geometry, warnings: res.warnings.filter((w) => !/nadmořské výšky; převýšení bude doplněno/.test(w)) };
          res.segments = res.segments.map((s) => withSegmentStats(s, geometry));
          res.warnings.push('Nadmořské výšky pocházejí z výškového modelu (Open-Meteo, přibližně ±10 m).');
        } catch (e) {
          if (e instanceof TrailPackError && e.code === 'aborted') throw e;
          res.warnings.push('Nadmořské výšky se nepodařilo načíst, převýšení není k dispozici.');
        }
      }
      res.distanceM = Math.round(lineLength(res.geometry));
      if (res.geometry.every((g) => g.length > 2)) {
        const st = elevationStats(res.geometry, 3);
        res.ascentM = Math.round(st.ascentM);
        res.descentM = Math.round(st.descentM);
      }
      out.push(res);
    }
    return out;
  }
}

function withSegmentStats<T extends { fromIdx: number; toIdx: number; distanceM: number; ascentM: number; descentM: number }>(s: T, geometry: readonly Position[]): T {
  const [seg] = buildSegments(geometry, [{ fromIdx: s.fromIdx, toIdx: s.toIdx }]);
  return seg ? { ...s, ascentM: seg.ascentM, descentM: seg.descentM, gradePct: seg.gradePct } : s;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export interface RouteComparisonRow {
  index: number;
  label: string;
  provider: RoutingProviderKey;
  profile: string;
  distanceM: number;
  ascentM: number;
  descentM: number;
  durationS?: number;
  /** Share of the route on paved surface (0–1), if surface data is available. */
  pavedShare?: number;
  /** Share on unpaved natural surfaces (gravel, ground, rock), 0–1. */
  naturalShare?: number;
  pros: string[];
  cons: string[];
}

export interface RouteComparison {
  rows: RouteComparisonRow[];
  /** Row indices of the best route per criterion. */
  best: { shortest: number; leastAscent: number; fastest?: number };
}

/** Human-readable (Czech) comparison table with pros and cons relative to the other candidates. */
export function compareRoutes(results: readonly RouteResult[], opts: { activity?: ActivityType } = {}): RouteComparison {
  const cycling = opts.activity ? isCyclingActivity(opts.activity) : false;
  const rows: RouteComparisonRow[] = results.map((r, index) => {
    const total = Object.values(r.surfaceSummary).reduce((a, b) => a + b, 0);
    const known = total - (r.surfaceSummary.unknown ?? 0);
    const share = (keys: string[]) => keys.reduce((a, k) => a + (r.surfaceSummary[k] ?? 0), 0) / (total || 1);
    return {
      index,
      label: index === 0 ? 'Hlavní trasa' : `Alternativa ${index}`,
      provider: r.provider,
      profile: r.profile,
      distanceM: r.distanceM,
      ascentM: r.ascentM,
      descentM: r.descentM,
      durationS: r.durationS,
      pavedShare: known > total * 0.5 ? share(['paved']) : undefined,
      naturalShare: known > total * 0.5 ? share(['gravel', 'ground', 'rock']) : undefined,
      pros: [],
      cons: [],
    };
  });
  const minBy = (f: (r: RouteComparisonRow) => number | undefined) => {
    let best = -1;
    let val = Infinity;
    rows.forEach((r, i) => {
      const v = f(r);
      if (v !== undefined && v < val) {
        val = v;
        best = i;
      }
    });
    return best;
  };
  const maxBy = (f: (r: RouteComparisonRow) => number) => rows.reduce((b, r, i) => (f(r) > f(rows[b]!) ? i : b), 0);
  const shortest = minBy((r) => r.distanceM);
  const leastAscent = minBy((r) => r.ascentM);
  const fastest = minBy((r) => r.durationS);
  const longest = maxBy((r) => r.distanceM);
  const mostAscent = maxBy((r) => r.ascentM);
  const multi = rows.length > 1;

  rows.forEach((row, i) => {
    const r = results[i]!;
    if (multi) {
      if (i === shortest) row.pros.push(`Nejkratší (o ${formatDistance(rows[longest]!.distanceM - row.distanceM)} kratší než nejdelší varianta)`);
      if (i === leastAscent && rows[mostAscent]!.ascentM - row.ascentM >= 20) row.pros.push(`Nejmenší stoupání (o ${Math.round(rows[mostAscent]!.ascentM - row.ascentM)} m méně)`);
      if (fastest >= 0 && i === fastest && row.durationS !== undefined) row.pros.push(`Nejrychlejší (${formatDuration(row.durationS / 60)})`);
      if (i === longest && i !== shortest) row.cons.push(`Nejdelší varianta (+${formatDistance(row.distanceM - rows[shortest]!.distanceM)})`);
      if (i === mostAscent && row.ascentM - rows[leastAscent]!.ascentM >= 20) row.cons.push(`Nejvíce stoupání (+${Math.round(row.ascentM - rows[leastAscent]!.ascentM)} m)`);
    }
    if (row.naturalShare !== undefined && row.naturalShare >= 0.5) {
      row.pros.push(`Převážně přírodní povrch (${Math.round(row.naturalShare * 100)} %)`);
    }
    if (row.pavedShare !== undefined && row.pavedShare >= 0.6) {
      (cycling && opts.activity === 'road_cycling' ? row.pros : row.cons).push(`Většinou zpevněný povrch (${Math.round(row.pavedShare * 100)} %)`);
    }
    const stairs = r.segments.filter((s) => s.wayType === 'steps').reduce((a, s) => a + s.distanceM, 0);
    if (stairs > 50) row.cons.push(`Schody na ${Math.round(stairs)} m`);
    for (const w of r.warnings.filter((x) => /omezeným|alpským|vyhýb/i.test(x)).slice(0, 2)) row.cons.push(w);
    if (row.pros.length === 0 && !multi) row.pros.push('Jediná dostupná varianta');
  });
  return { rows, best: { shortest, leastAscent, fastest: fastest >= 0 ? fastest : undefined } };
}

// ---------------------------------------------------------------------------
// Entity conversion
// ---------------------------------------------------------------------------

export interface RouteToEntityOptions {
  name: string;
  activity: ActivityType;
  /** User waypoints (start, via…, end). */
  waypoints: Array<LatLon & { name?: string }>;
  description?: string;
  id?: string;
}

/** Converts a routing result to a persistable, schema-validated `Route`. */
export function routeToEntity(result: RouteResult, opts: RouteToEntityOptions): Route {
  const stats = elevationStats(result.geometry, 3);
  const first = result.geometry[0]!;
  const last = result.geometry[result.geometry.length - 1]!;
  const closeEnds = haversine({ lat: first[1], lon: first[0] }, { lat: last[1], lon: last[0] }) < 150;
  const waypoints: RouteWaypoint[] = opts.waypoints.map((w, i, arr) => ({
    id: uuid(),
    order: i,
    lat: w.lat,
    lon: w.lon,
    name: w.name,
    type: i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'via',
  }));
  return RouteSchema.parse({
    ...newEntityBase(opts.id),
    name: opts.name,
    description: opts.description,
    activityType: opts.activity,
    source: result.provider,
    profile: result.profile,
    geometry: result.geometry,
    waypoints,
    segments: result.segments,
    distanceM: result.distanceM,
    ascentM: result.ascentM,
    descentM: result.descentM,
    minEleM: stats.minEleM,
    maxEleM: stats.maxEleM,
    surfaceSummary: result.surfaceSummary,
    isLoop: closeEnds && result.distanceM > 1000,
    favorite: false,
    attribution: result.attribution || undefined,
  });
}
