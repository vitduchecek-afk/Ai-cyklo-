/**
 * Expedition planner: orchestrates ports (routing, campsites, regulations,
 * weather, gear, nutrition …) into a complete multi-day plan. Every section
 * is resilient – a failing port yields an `unavailable` section with an error
 * code and the plan continues. Nothing is persisted here; the caller saves the
 * returned `draft` after user confirmation.
 */
import {
  TripSettingsSchema,
  TrailPackError,
  addDays,
  isTrailPackError,
  type Advisory,
  type BBox,
  type LatLon,
  type LegalStatus,
  type SleepType,
} from '@trailpack/shared';
import { bboxOf, bufferBBox, cumulativeDistances } from '@trailpack/calculations';
import { analyzeTrip, prioritize, type RecommendationAdvisory, type TripAnalysisDay } from '../recommendations/engine';
import type { CalcRecord, CampsiteResult, PeakResult, RouteOption, ToolPorts } from '../tools/ports';
import type { ParsedTripRequest } from './parse';
import type {
  AlternativeOption,
  ChainInfo,
  ChecklistEntry,
  ConstraintResult,
  DayItinerary,
  DayWater,
  ExpeditionPlan,
  ExpeditionRequest,
  FoodPlan,
  GearPlan,
  NamedPoint,
  NightPlan,
  PlanOptions,
  PowerPlan,
  RegionInfo,
  RouteOptionSummary,
  Section,
  StagePlan,
  TripDayDraft,
  WeatherDay,
  WeatherPlan,
} from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Forecast data is not available further ahead than this. */
export const FORECAST_HORIZON_DAYS = 16;
const NO_FORECAST = 'předpověď zatím není k dispozici';
const ROAD_FACTOR = 1.3; // route length / straight-line length
const ONE_ROUTE_ATTEMPT_MSG = 'Bez trasy nelze tuto část spočítat.';

export class SkipSection extends Error {}

export interface PlanContext {
  ports: ToolPorts;
  signal?: AbortSignal;
  onProgress?: PlanOptions['onProgress'];
  maxRouteOptions: number;
}

const STEP_TOTAL = 11;
const STEP_INDEX: Record<string, number> = {
  region: 1, routing: 2, stages: 3, nights: 4, weather: 5, water: 6, gear: 7, food: 8, power: 9, itinerary: 10, finalize: 11,
};

export function progress(ctx: PlanContext, step: string, message: string): void {
  ctx.signal?.throwIfAborted();
  ctx.onProgress?.({ step, index: STEP_INDEX[step] ?? 0, total: STEP_TOTAL, message });
}

const codeOf = (e: unknown): string => (isTrailPackError(e) ? e.code : e instanceof Error && e.name === 'AbortError' ? 'aborted' : 'unknown');
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Run a section; map failures to `unavailable` and `SkipSection` to `skipped`. Abort always propagates. */
async function section<T>(ctx: PlanContext, fn: () => Promise<T>): Promise<Section<T>> {
  ctx.signal?.throwIfAborted();
  try {
    return { status: 'ok', data: await fn() };
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    if (e instanceof SkipSection) return { status: 'skipped', reason: e.message };
    return { status: 'unavailable', code: codeOf(e), message: msgOf(e) };
  }
}

const numOf = (r: CalcRecord | undefined, ...keys: string[]): number | undefined => {
  for (const k of keys) {
    const v = r?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
};
const boolOf = (r: CalcRecord | undefined, key: string): boolean | undefined => (typeof r?.[key] === 'boolean' ? (r[key] as boolean) : undefined);
const hhmm = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const m = /(?:^|T)(\d{2}:\d{2})/.exec(v);
  return m ? m[1] : undefined;
};
const kmStr = (m: number): string => (m / 1000).toFixed(1).replace('.', ',');
const hStr = (min: number): string => `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')} min`;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const dayDiff = (a: string, b: string): number => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

const SLEEP_CS: Record<SleepType, string> = {
  open_air: 'spaní venku',
  tarp: 'tarp',
  tent: 'stan',
  hammock: 'hamaka',
  bivy_bag: 'bivak',
  shelter: 'přístřešek',
  emergency_hut: 'nouzová chata',
  official_bivouac_site: 'oficiální bivakovací místo',
  campground: 'kemp',
  mountain_hut: 'horská chata',
  paid_lodging: 'placené ubytování',
};
const LEGAL_CS: Record<LegalStatus, string> = {
  verified_allowed: 'ověřeně povoleno',
  conditional: 'povoleno za podmínek',
  prohibited: 'zakázáno',
  unverified: 'neověřeno',
};
const WILD: readonly SleepType[] = ['open_air', 'tarp', 'tent', 'hammock', 'bivy_bag'];

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

/** Turn a parsed text request into a plannable request, applying sensible defaults (3 days, 20 km/day, tent). */
export function requestFromParsed(parsed: ParsedTripRequest, extra: Partial<ExpeditionRequest> = {}): ExpeditionRequest {
  const f = parsed.fields;
  const days = f.days ?? 3;
  const base: ExpeditionRequest = {
    region: { name: f.region ?? '', query: f.regionQuery, countryCode: f.countryCode },
    days,
    maxDailyKm: f.maxDailyKm ?? 20,
    activity: f.activity ?? (days > 1 ? 'trekking' : 'hiking'),
    sleepType: f.sleepType ?? 'tent',
    excludeCampgrounds: f.excludeCampgrounds,
    legalOnly: f.legalOnly,
    avoidRain: f.avoidRain,
    weatherAware: f.weatherAware,
    startDate: f.startDate,
    targetBaseWeightG: f.targetBaseWeightG,
    people: f.people,
    gear: f.gear,
  };
  const defined = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined));
  return { ...base, ...defined };
}

function emptyPlan(request: ExpeditionRequest, now: Date): ExpeditionPlan {
  const skipped = { status: 'skipped', reason: 'Zatím nespočítáno.' } as const;
  return {
    request,
    generatedAt: now.toISOString(),
    region: skipped,
    routeOptions: [],
    stages: skipped,
    nights: skipped,
    water: skipped,
    weather: skipped,
    gear: skipped,
    food: skipped,
    power: skipped,
    itinerary: skipped,
    checklist: [],
    advisories: [],
    uncertainties: [],
    daySummaries: [],
    missingInfo: [],
    feasible: false,
    explanation: '',
    constraints: [],
    alternatives: [],
    cache: {},
  };
}

// ---------------------------------------------------------------------------
// Step 1: region
// ---------------------------------------------------------------------------

export async function stepRegion(plan: ExpeditionPlan, ctx: PlanContext): Promise<void> {
  progress(ctx, 'region', 'Hledám oblast…');
  plan.region = await section(ctx, async (): Promise<RegionInfo> => {
    const r = plan.request.region;
    if (r.bbox) {
      const [w, s, e, n] = r.bbox;
      return { name: r.name, bbox: r.bbox, center: { lat: (s + n) / 2, lon: (w + e) / 2 }, countryCode: r.countryCode, bboxEstimated: false };
    }
    const places = await ctx.ports.geocode(r.query ?? r.name, { limit: 3 });
    const p = places.find((x) => x.bbox) ?? places[0];
    if (!p) throw new TrailPackError('not_found', `Oblast „${r.name}“ nebyla nalezena.`);
    const bbox: BBox = p.bbox ?? bufferBBox(bboxOf([{ lat: p.lat, lon: p.lon }]), 25000);
    return {
      name: r.name || p.name,
      label: p.label,
      bbox,
      center: p.bbox ? { lat: (bbox[1] + bbox[3]) / 2, lon: (bbox[0] + bbox[2]) / 2 } : { lat: p.lat, lon: p.lon },
      countryCode: p.countryCode ?? r.countryCode,
      bboxEstimated: !p.bbox,
    };
  });
}

// ---------------------------------------------------------------------------
// Step 2: route candidates
// ---------------------------------------------------------------------------

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;

/**
 * Build candidate waypoint chains along the long axis of the region from
 * peaks (highest per segment, closest to the axis, median elevation). Falls
 * back to a straight axis chain when no peaks are available.
 */
export function buildChains(peaks: readonly PeakResult[], region: RegionInfo, req: ExpeditionRequest, scale: number): ChainInfo[] {
  const c = region.center;
  const cosLat = Math.cos((c.lat * Math.PI) / 180);
  const xy = (p: LatLon) => ({ x: (p.lon - c.lon) * cosLat * M_PER_DEG_LON, y: (p.lat - c.lat) * M_PER_DEG_LAT });
  const [w, s, e, n] = region.bbox;
  const width = (e - w) * cosLat * M_PER_DEG_LON;
  const height = (n - s) * M_PER_DEG_LAT;
  const horizontal = width >= height;
  const axisLen = Math.max(width, height);
  const targetStraight = (req.days * req.maxDailyKm * 1000 * 0.9) / ROAD_FACTOR;
  const L = clamp(targetStraight * scale, Math.min(axisLen * 0.2, 3000), axisLen * 0.95);
  const half = L / 2;
  const nPts = clamp(req.days + 1, 3, 8);
  const step = L / nPts;

  const proj = peaks.map((p) => {
    const q = xy(p);
    return { p, t: horizontal ? q.x : q.y, lat: horizontal ? q.y : q.x };
  });
  const inWindow = proj.filter((x) => x.t >= -half && x.t <= half);

  const pickers: { kind: string; pick: (b: typeof inWindow) => (typeof inWindow)[number] | undefined }[] = [
    { kind: 'ridge', pick: (b) => [...b].sort((x, y) => y.p.eleM - x.p.eleM)[0] },
    { kind: 'central', pick: (b) => [...b].sort((x, y) => Math.abs(x.lat) - Math.abs(y.lat))[0] },
    { kind: 'balanced', pick: (b) => [...b].sort((x, y) => y.p.eleM - x.p.eleM)[Math.floor(b.length / 2)] },
  ];
  const user = (pt: NamedPoint | undefined): NamedPoint[] => (pt ? [pt] : []);
  const chains: ChainInfo[] = [];
  const seen = new Set<string>();
  for (const { kind, pick } of pickers) {
    const pts: NamedPoint[] = [];
    for (let i = 0; i < nPts; i++) {
      const lo = -half + i * step;
      const bin = inWindow.filter((x) => x.t >= lo && (x.t < lo + step || i === nPts - 1));
      const chosen = pick(bin);
      if (chosen) pts.push({ lat: chosen.p.lat, lon: chosen.p.lon, name: chosen.p.name });
    }
    const ordered = [...user(req.start), ...pts, ...(req.viaPoints ?? []), ...user(req.end)];
    if (req.loop && ordered[0]) ordered.push(ordered[0]);
    if (ordered.length < 2) continue;
    const sig = ordered.map((q) => `${q.lat.toFixed(4)},${q.lon.toFixed(4)}`).join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    chains.push({ kind, scale, waypoints: ordered });
  }
  if (!chains.length) {
    const at = (t: number): NamedPoint => ({ lat: c.lat + (horizontal ? 0 : t) / M_PER_DEG_LAT, lon: c.lon + (horizontal ? t : 0) / (cosLat * M_PER_DEG_LON) });
    const pts = [...user(req.start), { ...at(-half * 0.95), name: 'Začátek osy oblasti' }, ...(req.viaPoints ?? []), { ...at(half * 0.95), name: 'Konec osy oblasti' }, ...user(req.end)];
    chains.push({ kind: 'axis', scale, waypoints: pts });
  }
  return chains;
}

interface Attempt {
  id: string;
  chain: ChainInfo;
  label: string;
  option: RouteOption;
  score: number;
  fits: boolean;
  deltaKm: number;
}

function scoreRoute(o: RouteOption, req: ExpeditionRequest): { score: number; fits: boolean; deltaKm: number } {
  const cap = req.days * req.maxDailyKm * 1000;
  const target = cap * 0.9;
  const d = o.distanceM;
  const distPenalty = d > cap ? ((d - cap) / cap) * 3 : d < 0.6 * cap ? ((0.6 * cap - d) / cap) * 2 : (Math.abs(d - target) / cap) * 0.5;
  const ascCap = req.maxDailyAscentM ? req.maxDailyAscentM * req.days : undefined;
  const ascPenalty = ascCap && o.ascentM > ascCap ? ((o.ascentM - ascCap) / ascCap) * 2 : (o.ascentM / Math.max(1, d / 1000) / 100) * 0.2;
  const score = distPenalty + ascPenalty + o.warnings.length * 0.02;
  const fits = d <= cap * 1.05 && d >= cap * 0.6 && (!ascCap || o.ascentM <= ascCap * 1.05);
  return { score, fits, deltaKm: (d - target) / 1000 };
}

/**
 * Find and compare route options, pick the best against days x km/day and
 * ascent, and re-route a trimmed/extended chain (max 2 iterations) when the
 * best option is far off. Pass `fixedChains` to route exactly those waypoints.
 */
export async function selectRoute(plan: ExpeditionPlan, ctx: PlanContext, fixedChains?: ChainInfo[]): Promise<void> {
  progress(ctx, 'routing', 'Porovnávám varianty trasy…');
  const req = plan.request;
  const region = plan.region.status === 'ok' ? plan.region.data : undefined;
  if (!region) throw new SkipSection('Oblast není určena.');

  let peaksFailed = false;
  if (!plan.cache.peaks && !fixedChains) {
    try {
      plan.cache.peaks = await ctx.ports.searchPeaks(region.bbox, 40);
    } catch {
      plan.cache.peaks = [];
      peaksFailed = true;
    }
  }
  const peaks = plan.cache.peaks ?? [];

  const attempts: Attempt[] = [];
  const sigs = new Set<string>();
  let lastError: unknown;
  const routeChain = async (chain: ChainInfo, label: string): Promise<void> => {
    const sig = chain.waypoints.map((p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join('|');
    if (sigs.has(sig)) return;
    sigs.add(sig);
    try {
      const options = await ctx.ports.route({ waypoints: chain.waypoints, activity: req.activity, preference: req.preference ?? 'marked_trails', alternatives: 1 });
      const option = options[0];
      if (!option) throw new TrailPackError('no_route', 'Routovací služba nevrátila žádnou trasu.');
      const id = attempts.some((a) => a.id === option.id) ? `${option.id}-${attempts.length}` : option.id;
      attempts.push({ id, chain, label, option, ...scoreRoute(option, req) });
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      lastError = e;
    }
  };
  const best = (): Attempt | undefined => [...attempts].sort((a, b) => a.score - b.score)[0];

  const chains = fixedChains ?? buildChains(peaks, region, req, 1).slice(0, ctx.maxRouteOptions);
  const kindLabel: Record<string, string> = { ridge: 'Hřebenová (nejvyšší vrcholy)', central: 'Středem oblasti', balanced: 'Vyvážená', axis: 'Přímá osa oblasti', user: 'Upravená uživatelem' };
  await Promise.all(chains.map((c) => routeChain(c, kindLabel[c.kind] ?? c.kind)));

  if (!fixedChains) {
    const cap = req.days * req.maxDailyKm * 1000;
    for (let iter = 0; iter < 2; iter++) {
      const b = best();
      if (!b) break;
      const d = b.option.distanceM;
      if (d <= cap * 1.1 && d >= cap * 0.6) break;
      const scale = clamp(b.chain.scale * ((cap * 0.9) / d), 0.3, 2);
      if (Math.abs(scale - b.chain.scale) < 0.05) break;
      const next = buildChains(peaks, region, req, scale).find((c) => c.kind === b.chain.kind);
      if (!next) break;
      const before = attempts.length;
      await routeChain(next, `${kindLabel[b.chain.kind] ?? b.chain.kind} – ${d > cap ? 'zkrácená' : 'prodloužená'}`);
      if (attempts.length === before) break;
    }
  }

  const chosen = best();
  if (!chosen) {
    plan.routeOptions = [];
    plan.chosenOptionId = undefined;
    plan.route = undefined;
    throw lastError ?? new TrailPackError('no_route', 'Žádnou trasu se nepodařilo spočítat.');
  }
  plan.routeOptions = attempts
    .sort((a, b) => a.score - b.score)
    .map(
      (a): RouteOptionSummary => ({
        id: a.id,
        kind: a.chain.kind,
        label: a.label,
        distanceKm: a.option.distanceM / 1000,
        ascentM: a.option.ascentM,
        descentM: a.option.descentM,
        provider: a.option.provider,
        warnings: [...a.option.warnings, ...(peaksFailed ? ['Vrcholy nebyly k dispozici – trasa vedena podél osy oblasti.'] : [])],
        waypoints: a.chain.waypoints,
        score: Math.round(a.score * 1000) / 1000,
        fits: a.fits,
        deltaToTargetKm: Math.round(a.deltaKm * 10) / 10,
        chosen: a.id === chosen.id,
      }),
    );
  plan.chosenOptionId = chosen.id;
  plan.route = chosen.option;
  plan.chain = chosen.chain;
}

// ---------------------------------------------------------------------------
// Step 3: stages
// ---------------------------------------------------------------------------

function campMatchesSleep(c: CampsiteResult, req: ExpeditionRequest): boolean {
  if (req.excludeCampgrounds && c.type === 'campground') return false;
  switch (req.sleepType) {
    case 'campground':
      return c.type === 'campground';
    case 'mountain_hut':
      return c.type === 'alpine_hut' || c.type === 'wilderness_hut' || c.type === 'hostel';
    case 'paid_lodging':
      return c.type === 'hostel' || c.type === 'hotel';
    default:
      return true;
  }
}

async function loadCampsites(plan: ExpeditionPlan, ctx: PlanContext): Promise<CampsiteResult[]> {
  if (plan.cache.campsites) return plan.cache.campsites;
  try {
    plan.cache.campsites = await ctx.ports.searchCampsites({ routeGeometry: plan.route!.geometry, corridorM: 1500 });
    plan.cache.campsitesError = undefined;
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    plan.cache.campsites = [];
    plan.cache.campsitesError = codeOf(e);
  }
  return plan.cache.campsites;
}

export async function stepStages(plan: ExpeditionPlan, ctx: PlanContext): Promise<void> {
  progress(ctx, 'stages', 'Rozděluji trasu na etapy…');
  const req = plan.request;
  plan.stages = await section(ctx, async (): Promise<StagePlan[]> => {
    const route = plan.route;
    if (!route) throw new SkipSection(ONE_ROUTE_ATTEMPT_MSG);
    const camps = await loadCampsites(plan, ctx);
    const anchors = camps
      .filter((c) => c.alongRouteM !== undefined && campMatchesSleep(c, req))
      .map((c) => ({ id: c.id, alongM: c.alongRouteM!, name: c.name, type: c.type, legalStatus: c.legalStatus }));
    const stages = await ctx.ports.calc.splitStages(route.geometry, {
      days: req.days,
      maxDailyKm: req.maxDailyKm,
      maxDailyAscentM: req.maxDailyAscentM,
      paceKmh: req.paceKmh,
      anchors,
      activity: req.activity,
    });
    if (!stages.length) throw new TrailPackError('provider_error', 'Rozdělení na etapy nevrátilo žádný výsledek.');
    const cum = cumulativeDistances(route.geometry);
    return stages.map((st): StagePlan => {
      const endPos = route.geometry[st.toIdx] ?? route.geometry[route.geometry.length - 1]!;
      return { ...st, startKm: (cum[st.fromIdx] ?? 0) / 1000, endKm: (cum[st.toIdx] ?? 0) / 1000, end: { lat: endPos[1], lon: endPos[0] } };
    });
  });
}

// ---------------------------------------------------------------------------
// Step 4: nights (legality)
// ---------------------------------------------------------------------------

const rank = (s: LegalStatus): number => ({ verified_allowed: 0, conditional: 1, unverified: 2, prohibited: 3 })[s];

function sleepTypeFor(c: CampsiteResult, fallback: SleepType): SleepType {
  switch (c.type) {
    case 'campground': return 'campground';
    case 'alpine_hut': return 'mountain_hut';
    case 'wilderness_hut': return 'emergency_hut';
    case 'bivouac_site': return 'official_bivouac_site';
    case 'shelter': return 'shelter';
    case 'hostel':
    case 'hotel': return 'paid_lodging';
    default: return fallback;
  }
}

interface Evaluation {
  status: LegalStatus;
  checkError?: string;
  countryCode?: string;
  areas: string[];
  disclaimer?: string;
  missing: string[];
}

async function evaluatePlace(ctx: PlanContext, at: LatLon, sleepType: SleepType, stove: boolean, camp?: CampsiteResult): Promise<Evaluation> {
  const ports = ctx.ports;
  let checkError: string | undefined;
  let country: { countryCode: string; confidence: number } | undefined;
  let areas: Awaited<ReturnType<ToolPorts['protectedAreasAt']>> = [];
  try {
    country = await ports.detectCountry(at.lat, at.lon);
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    checkError = codeOf(e);
  }
  try {
    areas = await ports.protectedAreasAt(at.lat, at.lon);
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    checkError ??= codeOf(e);
  }
  try {
    const res = await ports.checkRegulations({
      countryCode: country && country.confidence >= 0.5 ? country.countryCode : undefined,
      protectedAreas: areas,
      sleepType,
      campfire: false,
      stove,
      placeLegalStatus: camp?.legalStatus,
    });
    return { status: res.overall, checkError, countryCode: country?.countryCode, areas: areas.map((a) => a.name), disclaimer: res.disclaimer, missing: res.missingInfo };
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    return { status: 'unverified', checkError: codeOf(e), countryCode: country?.countryCode, areas: areas.map((a) => a.name), missing: ['Pravidla se nepodařilo ověřit.'] };
  }
}

export async function stepNights(plan: ExpeditionPlan, ctx: PlanContext): Promise<void> {
  progress(ctx, 'nights', 'Ověřuji legálnost nocí…');
  const req = plan.request;
  const stove = req.stove ?? true;
  const acceptable = (s: LegalStatus): boolean => s === 'verified_allowed' || (s === 'conditional' && !req.legalOnly);
  plan.nights = await section(ctx, async (): Promise<NightPlan[]> => {
    if (plan.stages.status !== 'ok' || !plan.route) throw new SkipSection('Bez etap nelze určit noclehy.');
    const stages = plan.stages.data;
    const camps = await loadCampsites(plan, ctx);
    const wild = WILD.includes(req.sleepType);
    const nights: NightPlan[] = [];

    for (const st of stages.slice(0, -1)) {
      const endAlong = st.endKm * 1000;
      const near = camps
        .filter((c) => c.alongRouteM !== undefined && Math.abs(c.alongRouteM - endAlong) <= 3000 && campMatchesSleep(c, req))
        .sort((a, b) => Math.abs(a.alongRouteM! - endAlong) - Math.abs(b.alongRouteM! - endAlong));
      const anchor = st.endAnchorId ? camps.find((c) => c.id === st.endAnchorId) : undefined;
      const ordered: (CampsiteResult | undefined)[] = [];
      if (anchor) ordered.push(anchor);
      if (wild) ordered.push(undefined); // the stage end point itself
      for (const c of near) if (c !== anchor && ordered.length < 5) ordered.push(c);
      if (!ordered.length) ordered.push(undefined);

      let bestPick: { cand: CampsiteResult | undefined; ev: Evaluation; mismatch: number; order: number } | undefined;
      let checked = 0;
      for (const [order, cand] of ordered.entries()) {
        const at = cand ? { lat: cand.lat, lon: cand.lon } : st.end;
        const ev = await evaluatePlace(ctx, at, cand ? sleepTypeFor(cand, req.sleepType) : req.sleepType, stove, cand);
        checked++;
        const mismatch = cand && wild && sleepTypeFor(cand, req.sleepType) !== req.sleepType ? 1 : 0;
        const pick = { cand, ev, mismatch, order };
        if (!bestPick || rank(ev.status) < rank(bestPick.ev.status) || (rank(ev.status) === rank(bestPick.ev.status) && mismatch < bestPick.mismatch)) bestPick = pick;
        if (ev.status === 'verified_allowed' && mismatch === 0) break;
      }
      const pick = bestPick!;
      const at = pick.cand ? { lat: pick.cand.lat, lon: pick.cand.lon } : st.end;
      const ok = acceptable(pick.ev.status);
      const night: NightPlan = {
        afterDay: st.index,
        lat: at.lat,
        lon: at.lon,
        place: pick.cand ? { id: pick.cand.id, name: pick.cand.name, type: pick.cand.type, official: pick.cand.type !== 'other' } : undefined,
        legalStatus: pick.ev.status,
        acceptable: ok,
        noLegalOption: !ok,
        protectedAreas: pick.ev.areas,
        countryCode: pick.ev.countryCode,
        disclaimer: pick.ev.disclaimer,
        missingInfo: pick.ev.missing,
        checkError: pick.ev.checkError,
        alternatives: [],
        candidatesChecked: checked,
      };

      if (!ok) {
        const alts: AlternativeOption[] = [];
        const official = camps
          .filter((c) => c.alongRouteM !== undefined && Math.abs(c.alongRouteM - endAlong) <= 8000 && c.legalStatus === 'verified_allowed' && ['campground', 'alpine_hut', 'wilderness_hut', 'hostel', 'hotel', 'bivouac_site', 'shelter'].includes(c.type))
          .sort((a, b) => Math.abs(a.alongRouteM! - endAlong) - Math.abs(b.alongRouteM! - endAlong))
          .slice(0, 3);
        for (const c of official) {
          const dKm = ((c.alongRouteM! - endAlong) / 1000).toFixed(1).replace('.', ',');
          alts.push({ kind: 'official_site', campsiteId: c.id, legalStatus: c.legalStatus, label: `${c.name ?? 'Oficiální místo'} (${c.type}), ${dKm} km od konce etapy – ověřeně povoleno` });
        }
        const others = (['tent', 'bivy_bag', 'tarp', 'open_air', 'official_bivouac_site'] as SleepType[]).filter((t) => t !== req.sleepType).slice(0, 3);
        for (const t of others) {
          const ev = await evaluatePlace(ctx, st.end, t, stove);
          if (acceptable(ev.status)) alts.push({ kind: 'other_sleep_type', sleepType: t, legalStatus: ev.status, label: `Přenocování jako ${SLEEP_CS[t]} zde vychází: ${LEGAL_CS[ev.status]}` });
        }
        alts.push({ kind: 'adjust_route', label: 'Posunout konec etapy k legálnímu místu, nebo přidat den.' });
        night.alternatives = alts;
      }
      nights.push(night);
    }
    return nights;
  });
}

// ---------------------------------------------------------------------------
// Step 5: weather
// ---------------------------------------------------------------------------

function weatherAdvisories(days: WeatherDay[], req: ExpeditionRequest): RecommendationAdvisory[] {
  const out: RecommendationAdvisory[] = [];
  const mk = (code: string, severity: Advisory['severity'], message: string, day: number, basis: string[], action: string, alternatives: string[] = []): void => {
    out.push({ code, severity, message, params: { day }, basis, action, alternatives, uncertainty: 'Předpověď je pravděpodobnostní a mění se; ověřte ji těsně před odchodem.', source: 'weather' });
  };
  for (const d of days) {
    if (d.rainRisk === 'high') {
      mk('weather.rain', req.avoidRain ? 'warning' : 'info', `Den ${d.day + 1}: vysoká pravděpodobnost deště (${Math.round(d.precipMaxProbPct ?? 0)} %${d.precipSumMm !== undefined ? `, ${d.precipSumMm.toFixed(1).replace('.', ',')} mm` : ''}).`, d.day + 1, ['Předpověď srážek podél trasy'], req.avoidRain ? 'Zvažte posun termínu, kratší etapu nebo noc v chatě.' : 'Připravte pláštěnku a nepromokavé obaly.', ['Posunout termín o den či dva', 'Přespat v chatě']);
    }
    if (d.gustMaxKmh !== undefined && d.gustMaxKmh >= 45) {
      mk('weather.wind', d.gustMaxKmh >= 60 ? 'danger' : 'warning', `Den ${d.day + 1}: nárazy větru až ${Math.round(d.gustMaxKmh)} km/h.`, d.day + 1, [`Nárazy ${Math.round(d.gustMaxKmh)} km/h`], 'Vyhněte se exponovaným hřebenům, zvolte závětrný nocleh.', ['Nižší varianta trasy mimo hřeben']);
    }
    if (d.tempMinC !== undefined && d.tempMinC <= 0) {
      mk('weather.frost', 'warning', `Den ${d.day + 1}: teplota klesne na ${Math.round(d.tempMinC)} °C.`, d.day + 1, [`Minimum ${Math.round(d.tempMinC)} °C`], 'Připravte teplé vrstvy a ověřte komfort spacáku.');
    }
    if (d.tempMaxC !== undefined && d.tempMaxC >= 30) {
      mk('weather.heat', 'warning', `Den ${d.day + 1}: horko až ${Math.round(d.tempMaxC)} °C.`, d.day + 1, [`Maximum ${Math.round(d.tempMaxC)} °C`], 'Zvyšte zásobu vody, vyrazte brzy, plánujte pauzu ve stínu.');
    }
  }
  return out;
}

export async function stepWeather(plan: ExpeditionPlan, ctx: PlanContext): Promise<void> {
  progress(ctx, 'weather', 'Zjišťuji počasí podél trasy…');
  const req = plan.request;
  plan.weather = await section(ctx, async (): Promise<WeatherPlan> => {
    if (!plan.route || plan.stages.status !== 'ok') throw new SkipSection(ONE_ROUTE_ATTEMPT_MSG);
    if (!req.startDate) throw new SkipSection('Datum výpravy není zadáno, počasí nelze určit.');
    const ahead = dayDiff(req.startDate, ctx.ports.now().toISOString().slice(0, 10));
    if (ahead > FORECAST_HORIZON_DAYS) throw new SkipSection(`Předpověď zatím není k dispozici (výprava začíná za ${ahead} dní).`);
    const stages = plan.stages.data;
    const startIso = new Date(`${req.startDate}T${req.startTime ?? '08:00'}:00`).toISOString();
    const samples = await ctx.ports.weatherAlongRoute(plan.route.geometry, startIso, stages.map((s) => s.toIdx));
    if (!samples.length || samples.every((s) => s.beyondHorizon)) throw new SkipSection(`Počasí: ${NO_FORECAST}.`);

    const byDay = new Map<number, typeof samples>();
    for (const s of samples) {
      const idx = clamp(dayDiff(s.etaIso.slice(0, 10), req.startDate), 0, stages.length - 1);
      if (Number.isNaN(idx)) continue;
      byDay.set(idx, [...(byDay.get(idx) ?? []), s]);
    }
    const days: WeatherDay[] = [];
    for (let i = 0; i < stages.length; i++) {
      const ss = byDay.get(i) ?? [];
      const hours = ss.flatMap((s) => (s.hour && !s.beyondHorizon ? [s.hour] : []));
      const vals = (f: (h: (typeof hours)[number]) => number | null): number[] => hours.map(f).filter((v): v is number => v !== null);
      const temps = vals((h) => h.temperatureC);
      const probs = vals((h) => h.precipitationProbabilityPct);
      const mm = vals((h) => h.precipitationMm);
      const winds = vals((h) => h.windSpeedKmh);
      const gusts = vals((h) => h.windGustsKmh);
      const maxProb = probs.length ? Math.max(...probs) : undefined;
      const sumMm = mm.length ? mm.reduce((a, b) => a + b, 0) : undefined;
      const rainRisk: WeatherDay['rainRisk'] = (maxProb ?? 0) >= 70 || (sumMm ?? 0) >= 3 ? 'high' : (maxProb ?? 0) >= 40 || (sumMm ?? 0) >= 1 ? 'medium' : 'low';
      days.push({
        day: i,
        date: addDays(req.startDate, i),
        tempMinC: temps.length ? Math.min(...temps) : undefined,
        tempMaxC: temps.length ? Math.max(...temps) : undefined,
        precipMaxProbPct: maxProb,
        precipSumMm: sumMm,
        windMaxKmh: winds.length ? Math.max(...winds) : undefined,
        gustMaxKmh: gusts.length ? Math.max(...gusts) : undefined,
        rainRisk,
        samples: ss.length,
        beyondHorizon: ss.filter((s) => s.beyondHorizon).length,
        lowConfidence: ss.some((s) => s.confidence === 'low'),
      });
    }
    return { days, partial: samples.some((s) => s.beyondHorizon), advisories: prioritize(weatherAdvisories(days, req)) };
  });
}

// ---------------------------------------------------------------------------
// Step 6: water
// ---------------------------------------------------------------------------

export async function stepWater(plan: ExpeditionPlan, ctx: PlanContext): Promise<void> {
  progress(ctx, 'water', 'Hledám zdroje vody…');
  plan.water = await section(ctx, async (): Promise<DayWater[]> => {
    if (!plan.route || plan.stages.status !== 'ok') throw new SkipSection(ONE_ROUTE_ATTEMPT_MSG);
    if (!plan.cache.waterSources) {
      plan.cache.waterSources = await ctx.ports.searchWaterSources({ routeGeometry: plan.route.geometry, corridorM: 500 });
    }
    const sources = plan.cache.waterSources;
    const weatherDays = plan.weather.status === 'ok' ? plan.weather.data.days : [];
    const results = await Promise.allSettled(
      plan.stages.data.map(async (st): Promise<DayWater> => {
        const inStage = sources.filter((w) => w.alongRouteM !== undefined && w.alongRouteM >= st.startKm * 1000 && w.alongRouteM <= st.endKm * 1000);
        const positions = inStage.map((w) => w.alongRouteM! / 1000).sort((a, b) => a - b);
        const marks = [st.startKm, ...positions, st.endKm];
        let gap = 0;
        for (let i = 1; i < marks.length; i++) gap = Math.max(gap, marks[i]! - marks[i - 1]!);
        const base: DayWater = {
          day: st.index,
          sourcesCount: inStage.length,
          longestDryGapKm: Math.round(gap * 10) / 10,
          unknownPotability: inStage.filter((w) => w.potability === 'unknown' || w.confidence === 'low').length,
        };
        const calc = await ctx.ports.calc.waterNeeds({
          distanceKm: st.distanceM / 1000,
          ascentM: st.ascentM,
          durationHours: st.movingMin / 60,
          tempC: weatherDays[st.index]?.tempMaxC,
          sourcesAlongKm: positions.map((p) => Math.round((p - st.startKm) * 10) / 10),
          dryGapKm: base.longestDryGapKm,
        });
        return { ...base, carryL: numOf(calc, 'carryL'), requiredL: numOf(calc, 'requiredL'), sufficient: boolOf(calc, 'sufficient'), deficitL: numOf(calc, 'deficitL'), calc };
      }),
    );
    if (results.every((r) => r.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason;
    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const st = plan.stages.status === 'ok' ? plan.stages.data[i]! : undefined;
      return { day: i, sourcesCount: 0, longestDryGapKm: st ? st.endKm - st.startKm : 0, unknownPotability: 0, error: codeOf(r.reason) };
    });
  });
}

// ---------------------------------------------------------------------------
// Step 7: gear
// ---------------------------------------------------------------------------

export async function stepGear(plan: ExpeditionPlan, ctx: PlanContext): Promise<void> {
  progress(ctx, 'gear', 'Počítám hmotnost vybavení…');
  const req = plan.request;
  plan.gear = await section(ctx, async (): Promise<GearPlan> => {
    const loadouts = await ctx.ports.gear.listLoadouts();
    const pick =
      loadouts.find((l) => l.id === req.loadoutId) ??
      loadouts.find((l) => l.activityType === req.activity) ??
      loadouts.find((l) => l.favorite) ??
      loadouts.find((l) => !l.isTemplate) ??
      loadouts[0];
    if (!pick) throw new TrailPackError('not_found', 'Není uložena žádná sada vybavení.');
    const { loadout, entries } = await ctx.ports.gear.getLoadout(pick.id);
    const weight = await ctx.ports.calc.packWeight(entries);
    const base = numOf(weight, 'baseWeightG', 'baseG');
    const total = numOf(weight, 'totalWeightG', 'totalG');
    const target = req.targetBaseWeightG ?? loadout.targetBaseWeightG;
    let potential: number | undefined;
    let suggestions: unknown[] = [];
    try {
      const opt = await ctx.ports.calc.optimizeGear({ entries, loadout, targetBaseWeightG: target, activity: req.activity, days: req.days });
      potential = numOf(opt, 'potentialSavingG', 'savingsG');
      suggestions = Array.isArray(opt['suggestions']) ? (opt['suggestions'] as unknown[]).slice(0, 10) : [];
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
    }
    return {
      loadoutId: loadout.id,
      loadoutName: loadout.name,
      baseWeightG: base,
      totalWeightG: total,
      targetBaseWeightG: target,
      overTargetG: target !== undefined && base !== undefined ? Math.max(0, base - target) : undefined,
      potentialSavingG: potential,
      suggestions,
      weight,
    };
  });
}

// ---------------------------------------------------------------------------
// Steps 8-9: food/energy and power
// ---------------------------------------------------------------------------

export async function stepFood(plan: ExpeditionPlan, ctx: PlanContext): Promise<void> {
  progress(ctx, 'food', 'Počítám energii a jídlo…');
  const req = plan.request;
  plan.food = await section(ctx, async (): Promise<FoodPlan> => {
    if (plan.stages.status !== 'ok') throw new SkipSection(ONE_ROUTE_ATTEMPT_MSG);
    const packKg = plan.gear.status === 'ok' && plan.gear.data.totalWeightG !== undefined ? plan.gear.data.totalWeightG / 1000 : undefined;
    const energies = await Promise.all(
      plan.stages.data.map((st) =>
        ctx.ports.calc.energy({ distanceKm: st.distanceM / 1000, ascentM: st.ascentM, movingMin: st.movingMin, bodyWeightKg: req.bodyWeightKg, packWeightKg: packKg, activity: req.activity }),
      ),
    );
    const perDay = energies.map((e) => numOf(e, 'kcal') ?? 0);
    const needed = perDay.length ? perDay.reduce((a, b) => a + b, 0) / perDay.length : undefined;
    const food = await ctx.ports.calc.foodPlan({ days: plan.stages.data.length, energyKcalPerDay: perDay, people: req.people ?? 1 });
    return { neededKcalPerDay: needed, plannedKcalPerDay: numOf(food, 'kcalPerDay'), perDayKcal: perDay, totalWeightG: numOf(food, 'totalWeightG'), food, estimated: true };
  });
}

export async function stepPower(plan: ExpeditionPlan, ctx: PlanContext): Promise<void> {
  progress(ctx, 'power', 'Kontroluji napájení…');
  const req = plan.request;
  plan.power = await section(ctx, async (): Promise<PowerPlan> => {
    if (!req.devices?.length && !req.gear?.powerbankMah) throw new SkipSection('Zařízení ani powerbanka nejsou zadány, napájení nelze spočítat.');
    const days = plan.stages.status === 'ok' ? plan.stages.data.length : req.days;
    const result = await ctx.ports.calc.power({ days, devices: req.devices ?? [], powerbankMah: req.gear?.powerbankMah });
    return { sufficient: boolOf(result, 'sufficient'), reservePct: numOf(result, 'reservePct'), result, estimated: true };
  });
}

// ---------------------------------------------------------------------------
// Step 10: itinerary
// ---------------------------------------------------------------------------

export async function stepItinerary(plan: ExpeditionPlan, ctx: PlanContext): Promise<void> {
  progress(ctx, 'itinerary', 'Sestavuji itinerář…');
  const req = plan.request;
  plan.itinerary = await section(ctx, async (): Promise<DayItinerary[]> => {
    if (plan.stages.status !== 'ok') throw new SkipSection(ONE_ROUTE_ATTEMPT_MSG);
    const results = await Promise.allSettled(
      plan.stages.data.map(async (st): Promise<DayItinerary> => {
        const date = req.startDate ? addDays(req.startDate, st.index) : undefined;
        let sunrise: string | undefined;
        let sunset: string | undefined;
        if (date) {
          try {
            const sun = await ctx.ports.calc.sunTimes(date, st.end.lat, st.end.lon);
            sunrise = hhmm(sun['sunrise']);
            sunset = hhmm(sun['sunset']);
          } catch (e) {
            if (ctx.signal?.aborted) throw e;
          }
        }
        const schedule = await ctx.ports.calc.daySchedule({
          startTime: req.startTime ?? '08:00',
          movingMin: st.movingMin,
          distanceM: st.distanceM,
          ascentM: st.ascentM,
          breakMinutesPerHour: 10,
          sunset,
          sunrise,
        });
        const arrival = hhmm(schedule['arrival'] ?? schedule['arrivalTime']);
        const reserve = arrival && sunset ? toMin(sunset) - toMin(arrival) : undefined;
        return { day: st.index, date, departure: hhmm(schedule['departure']) ?? req.startTime ?? '08:00', arrival, sunrise, sunset, daylightReserveMin: reserve, schedule };
      }),
    );
    if (results.every((r) => r.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason;
    return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  });
}

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

// ---------------------------------------------------------------------------
// Step 11: finalize (pure, synchronous)
// ---------------------------------------------------------------------------

function evaluateConstraints(plan: ExpeditionPlan): ConstraintResult[] {
  const req = plan.request;
  const out: ConstraintResult[] = [];
  const cap = req.days * req.maxDailyKm * 1000;

  if (plan.stages.status === 'ok') {
    const stages = plan.stages.data;
    const over = stages.filter((s) => s.distanceM > req.maxDailyKm * 1100);
    const tooMany = stages.length > req.days;
    const met = !over.length && !tooMany;
    out.push({
      key: 'distance',
      met,
      blocking: true,
      detail: met
        ? `Všechny etapy mají nejvýše ${req.maxDailyKm} km (nejdelší ${kmStr(Math.max(...stages.map((s) => s.distanceM)))} km).`
        : tooMany
          ? `Trasa (${kmStr(plan.route?.distanceM ?? 0)} km) vyžaduje ${stages.length} etap místo ${req.days}.`
          : `Etapa ${over.map((s) => s.index + 1).join(', ')} má víc než ${req.maxDailyKm} km (nejdelší ${kmStr(Math.max(...over.map((s) => s.distanceM)))} km).`,
    });
    if (req.maxDailyAscentM) {
      const overAsc = stages.filter((s) => s.ascentM > req.maxDailyAscentM! * 1.1);
      out.push({ key: 'ascent', met: !overAsc.length, blocking: true, detail: overAsc.length ? `Stoupání v etapě ${overAsc.map((s) => s.index + 1).join(', ')} přesahuje ${req.maxDailyAscentM} m.` : `Stoupání v každé etapě je do ${req.maxDailyAscentM} m.` });
    }
  } else if (plan.route) {
    const met = plan.route.distanceM <= cap * 1.05;
    out.push({ key: 'distance', met, blocking: true, detail: met ? `Trasa má ${kmStr(plan.route.distanceM)} km (limit ${kmStr(cap)} km); rozdělení na etapy se nepodařilo.` : `Trasa má ${kmStr(plan.route.distanceM)} km, limit je ${kmStr(cap)} km.` });
  } else {
    out.push({ key: 'distance', met: false, blocking: true, detail: 'Trasu se nepodařilo spočítat.' });
  }

  if (plan.nights.status === 'ok') {
    const bad = plan.nights.data.filter((n) => !n.acceptable);
    out.push({
      key: 'legal_nights',
      met: !bad.length,
      blocking: true,
      detail: bad.length
        ? `Pro noc ${bad.map((n) => n.afterDay + 1).join(', ')} nebylo nalezeno legální místo (${SLEEP_CS[req.sleepType]}); nejlepší nalezený stav: ${bad.map((n) => LEGAL_CS[n.legalStatus]).join(', ')}.`
        : 'Všechny noclehy vycházejí legálně.',
    });
  }

  if (plan.gear.status === 'ok' && plan.gear.data.targetBaseWeightG !== undefined && plan.gear.data.baseWeightG !== undefined) {
    const g = plan.gear.data;
    const met = g.baseWeightG! <= g.targetBaseWeightG!;
    out.push({ key: 'base_weight', met, blocking: false, detail: met ? `Základní hmotnost ${(g.baseWeightG! / 1000).toFixed(2).replace('.', ',')} kg splňuje cíl.` : `Základní hmotnost ${(g.baseWeightG! / 1000).toFixed(2).replace('.', ',')} kg překračuje cíl ${(g.targetBaseWeightG! / 1000).toFixed(2).replace('.', ',')} kg o ${Math.round(g.overTargetG ?? 0)} g.` });
  }
  if (req.avoidRain && plan.weather.status === 'ok') {
    const wet = plan.weather.data.days.filter((d) => d.rainRisk === 'high');
    out.push({ key: 'weather', met: !wet.length, blocking: false, detail: wet.length ? `Déšť je pravděpodobný ve dnech: ${wet.map((d) => d.day + 1).join(', ')}.` : 'V předpovědi není výrazný déšť.' });
  }
  return out;
}

function buildAlternatives(plan: ExpeditionPlan, constraints: ConstraintResult[]): string[] {
  const req = plan.request;
  const alts: string[] = [];
  const unmet = (k: ConstraintResult['key']) => constraints.find((c) => c.key === k && !c.met);
  if (!plan.route) alts.push('Zadejte startovní a cílový bod ručně, nebo upřesněte oblast.');
  if (unmet('distance') && plan.route) {
    const km = plan.route.distanceM / 1000;
    alts.push(`Přidat den: ${req.days + 1} dnů vychází na ${Math.ceil(km / (req.days + 1))} km denně.`);
    alts.push(`Zvýšit denní limit na ${Math.ceil(km / req.days)} km (pokud to dovoluje kondice).`);
    alts.push('Zvolit kratší variantu trasy v menší části oblasti.');
  }
  if (unmet('ascent')) alts.push('Vybrat trasu s menším převýšením, nebo rozdělit náročné etapy.');
  if (unmet('legal_nights')) {
    if (plan.nights.status === 'ok') for (const n of plan.nights.data) for (const a of n.alternatives) if (a.kind !== 'adjust_route') alts.push(`Noc ${n.afterDay + 1}: ${a.label}`);
    alts.push('Přenocovat v oficiálním kempu nebo na chatě' + (req.excludeCampgrounds ? ' (vyžaduje povolit kempy)' : '') + '.');
    alts.push('Zkusit jiný způsob spaní, který je v dané lokalitě povolen.');
  }
  if (unmet('base_weight') && plan.gear.status === 'ok') {
    const s = plan.gear.data.potentialSavingG;
    alts.push(s ? `Použít návrhy optimalizace vybavení (úspora až ${Math.round(s)} g).` : 'Projít vybavení a vyřadit nepotřebné věci.');
    alts.push('Mírně zvýšit cílovou základní hmotnost.');
  }
  if (unmet('weather')) alts.push('Posunout termín na dny bez deště, nebo počítat s nocí v chatě.');
  return [...new Set(alts)];
}

function buildChecklist(plan: ExpeditionPlan): ChecklistEntry[] {
  const req = plan.request;
  const list: ChecklistEntry[] = [
    { category: 'navigation', text: 'Stáhnout offline mapy oblasti a uložit GPX trasy.', reason: 'V horách bývá slabý signál.' },
    { category: 'safety', text: 'Sdílet plán a předpokládané časy s blízkou osobou.', reason: 'Pro případ nouze.' },
    { category: 'safety', text: 'Ověřit aktuální uzávěry cest a výstrahy (správa parku, horská služba).', reason: 'Data mohou být zastaralá.' },
  ];
  if (plan.nights.status === 'ok') {
    for (const n of plan.nights.data) {
      if (n.legalStatus !== 'verified_allowed') list.push({ category: 'legal', text: `Noc ${n.afterDay + 1}: ověřit pravidla přenocování (${LEGAL_CS[n.legalStatus]}).`, reason: n.disclaimer ?? 'Legálnost nebylo možné plně ověřit.' });
    }
  }
  if (plan.water.status === 'ok') {
    const dry = plan.water.data.filter((d) => d.longestDryGapKm >= 10 || d.sourcesCount === 0);
    if (dry.length) list.push({ category: 'water', text: `Naplnit zásobu vody před etapou ${dry.map((d) => d.day + 1).join(', ')} (dlouhé úseky bez zdroje).`, reason: 'Úseky bez zdroje vody 10 km a víc.' });
    if (plan.water.data.some((d) => d.unknownPotability > 0)) list.push({ category: 'water', text: 'Vzít filtr nebo tablety na úpravu vody.', reason: 'U některých zdrojů není jistá pitnost.' });
  }
  if (plan.weather.status === 'ok') {
    if (plan.weather.data.days.some((d) => d.rainRisk !== 'low')) list.push({ category: 'weather', text: 'Pláštěnka a nepromokavé obaly na elektroniku a spacák.', reason: 'V předpovědi je déšť.' });
    if (plan.weather.data.days.some((d) => (d.tempMinC ?? 99) <= 3)) list.push({ category: 'weather', text: 'Teplé spaní oblečení, čepice a rukavice.', reason: 'Noční teploty kolem nuly.' });
    list.push({ category: 'weather', text: 'Znovu zkontrolovat předpověď v den odchodu.', reason: 'Předpověď se mění.' });
  } else list.push({ category: 'weather', text: 'Zkontrolovat předpověď počasí před odchodem.', reason: NO_FORECAST });
  if (plan.power.status === 'ok') list.push({ category: 'power', text: 'Plně nabít powerbanku a telefon před odchodem.', reason: 'Rezerva závisí na plném nabití.' });
  if (plan.gear.status === 'ok' && (plan.gear.data.overTargetG ?? 0) > 0) list.push({ category: 'gear', text: 'Projít návrhy úspory hmotnosti u vybavení.', reason: 'Základní hmotnost je nad cílem.' });
  if (plan.food.status === 'ok') list.push({ category: 'food', text: 'Rozbalit a rozdělit jídlo po dnech, přidat rezervu na jeden den.', reason: 'Odhad spotřeby energie je přibližný.' });
  list.push({ category: 'safety', text: `Mít lékárničku, čelovku a nouzovou folii${req.people && req.people > 1 ? ' pro každého' : ''}.`, reason: 'Základní bezpečnostní výbava.' });
  return list;
}

function buildDraft(plan: ExpeditionPlan): ExpeditionPlan['draft'] {
  const req = plan.request;
  if (!plan.route || plan.stages.status !== 'ok') return undefined;
  const stages = plan.stages.data;
  const nights = plan.nights.status === 'ok' ? plan.nights.data : [];
  const itin = plan.itinerary.status === 'ok' ? plan.itinerary.data : [];
  const regionName = plan.region.status === 'ok' ? plan.region.data.name : req.region.name;
  const settings = TripSettingsSchema.parse({
    startTime: req.startTime,
    dailyDistanceKm: clamp(req.maxDailyKm, 1, 400),
    maxDailyAscentM: req.maxDailyAscentM,
    fitness: req.fitness,
    paceKmh: req.paceKmh,
    sleepType: req.sleepType,
    targetBaseWeightG: req.targetBaseWeightG,
    avoidRain: req.avoidRain ?? false,
  });
  const days: TripDayDraft[] = stages.map((st, i) => {
    const night = nights.find((n) => n.afterDay === st.index);
    const startPos = plan.route!.geometry[st.fromIdx];
    const sched = itin.find((d) => d.day === st.index);
    const total = sched?.arrival && sched.departure ? Math.max(0, toMin(sched.arrival) - toMin(sched.departure)) : st.movingMin;
    return {
      dayIndex: i,
      date: req.startDate ? addDays(req.startDate, i) : undefined,
      start: startPos ? { lat: startPos[1], lon: startPos[0] } : undefined,
      end: st.end,
      endName: night?.place?.name,
      fromIdx: st.fromIdx,
      toIdx: st.toIdx,
      distanceM: st.distanceM,
      ascentM: st.ascentM,
      descentM: st.descentM,
      movingTimeMin: st.movingMin,
      totalTimeMin: total,
      campsiteId: night?.place?.id ?? null,
      highlights: [],
      tasks: [],
    };
  });
  const nDays = stages.length;
  return {
    name: `${regionName} – ${nDays} ${nDays >= 2 && nDays <= 4 ? 'dny' : 'dní'}`,
    region: regionName,
    startDate: req.startDate,
    endDate: req.startDate ? addDays(req.startDate, nDays - 1) : undefined,
    activityType: req.activity,
    participantsCount: req.people ?? 1,
    loadoutId: plan.gear.status === 'ok' ? plan.gear.data.loadoutId : undefined,
    routeOptionId: plan.chosenOptionId,
    settings,
    days,
  };
}

/** Recompute everything derived from the sections (constraints, advisories, checklist, summaries, draft). Pure. */
export function finalizePlan(plan: ExpeditionPlan): void {
  const req = plan.request;
  const stages = plan.stages.status === 'ok' ? plan.stages.data : [];
  const nights = plan.nights.status === 'ok' ? plan.nights.data : [];
  const itin = plan.itinerary.status === 'ok' ? plan.itinerary.data : [];
  const water = plan.water.status === 'ok' ? plan.water.data : [];
  const weatherDays = plan.weather.status === 'ok' ? plan.weather.data.days : [];

  plan.constraints = evaluateConstraints(plan);
  const blockingUnmet = plan.constraints.filter((c) => c.blocking && !c.met);
  plan.feasible = !!plan.route && blockingUnmet.length === 0;
  const softUnmet = plan.constraints.filter((c) => !c.blocking && !c.met);
  plan.explanation = plan.feasible
    ? `Plán splňuje všechna zásadní omezení.${softUnmet.length ? ` Upozornění: ${softUnmet.map((c) => c.detail).join(' ')}` : ''}`
    : plan.region.status !== 'ok'
      ? `Plán nelze sestavit: ${plan.region.status === 'unavailable' ? plan.region.message : plan.region.reason}`
      : !plan.route
        ? 'Plán nelze sestavit: nepodařilo se spočítat žádnou trasu.'
        : `Plán se zadanými omezeními nelze splnit. ${blockingUnmet.map((c) => c.detail).join(' ')}`;
  plan.alternatives = plan.feasible && !softUnmet.length ? [] : buildAlternatives(plan, plan.constraints);

  const days: TripAnalysisDay[] = stages.map((st) => {
    const night = nights.find((n) => n.afterDay === st.index);
    const it = itin.find((d) => d.day === st.index);
    const w = water.find((d) => d.day === st.index);
    return {
      index: st.index,
      distanceM: st.distanceM,
      ascentM: st.ascentM,
      movingMin: st.movingMin,
      arrivalTime: it?.arrival,
      sunsetTime: it?.sunset,
      campsite: night ? { legalStatus: night.legalStatus, name: night.place?.name } : undefined,
      nightMinC: weatherDays[st.index]?.tempMinC,
      waterCarryL: w?.carryL,
      waterSourcesCount: plan.water.status === 'ok' ? w?.sourcesCount : undefined,
    };
  });
  const sufficientFlags = water.map((d) => d.sufficient).filter((v): v is boolean => v !== undefined);
  const gear = plan.gear.status === 'ok' ? plan.gear.data : undefined;
  const food = plan.food.status === 'ok' ? plan.food.data : undefined;
  const power = plan.power.status === 'ok' ? plan.power.data : undefined;
  plan.advisories = analyzeTrip({
    settings: { dailyDistanceKm: req.maxDailyKm, maxDailyAscentM: req.maxDailyAscentM ?? 0, sleepType: req.sleepType },
    days,
    fitness: req.fitness ?? 'moderate',
    packWeights: gear && gear.baseWeightG !== undefined && gear.totalWeightG !== undefined ? { baseG: gear.baseWeightG, totalG: gear.totalWeightG, targetBaseG: gear.targetBaseWeightG, bodyWeightKg: req.bodyWeightKg } : undefined,
    sleepingBagComfortC: req.gear?.sleepingBagComfortC,
    forecastRisks: plan.weather.status === 'ok' ? plan.weather.data.advisories : undefined,
    waterPlan: sufficientFlags.length ? { sufficient: sufficientFlags.every(Boolean), deficitL: Math.max(0, ...water.map((d) => d.deficitL ?? 0)) || undefined } : undefined,
    food: food && food.plannedKcalPerDay !== undefined && food.neededKcalPerDay !== undefined ? { plannedKcalPerDay: food.plannedKcalPerDay, neededKcalPerDay: food.neededKcalPerDay } : undefined,
    power: power && power.sufficient !== undefined ? { sufficient: power.sufficient, reservePct: power.reservePct ?? 0 } : undefined,
    optimizerSavingsG: gear?.potentialSavingG,
  });

  plan.checklist = buildChecklist(plan);

  const unc: string[] = [];
  const secs: [string, Section<unknown>][] = [['Oblast', plan.region], ['Etapy', plan.stages], ['Noclehy', plan.nights], ['Voda', plan.water], ['Počasí', plan.weather], ['Vybavení', plan.gear], ['Jídlo', plan.food], ['Napájení', plan.power], ['Itinerář', plan.itinerary]];
  for (const [label, s] of secs) {
    if (s.status === 'unavailable') unc.push(`${label}: nedostupné (${s.code}) – ${s.message}`);
    else if (s.status === 'skipped' && s.reason !== 'Zatím nespočítáno.') unc.push(`${label}: ${s.reason}`);
  }
  if (plan.cache.campsitesError) unc.push(`Tábořiště se nepodařilo načíst (${plan.cache.campsitesError}); noclehy jsou vyhodnoceny jen v konci etap.`);
  if (plan.weather.status === 'ok' && plan.weather.data.partial) unc.push(`Část trasy je mimo horizont předpovědi – ${NO_FORECAST}.`);
  if (nights.some((n) => n.checkError)) unc.push('Kontrola pravidel selhala u některých nocí; jejich legálnost je neověřená.');
  if (nights.length) unc.push('Pravidla přenocování se mohou měnit a mapová data nejsou úplná; za dodržení pravidel odpovídáte vy.');
  if (food) unc.push('Spotřeba energie, jídlo, voda a napájení jsou odhady.');
  if (plan.region.status === 'ok' && plan.region.data.bboxEstimated) unc.push('Hranice oblasti je odhadnutá kolem jednoho bodu.');
  plan.uncertainties = unc;

  const missing: string[] = [];
  if (!req.startDate) missing.push('Datum odchodu (kvůli počasí a času západu slunce).');
  if (req.bodyWeightKg === undefined) missing.push('Tělesná hmotnost (kvůli podílu váhy batohu a spotřebě energie).');
  if (req.gear?.sleepingBagComfortC === undefined) missing.push('Komfortní teplota spacáku.');
  if (!req.devices?.length && !req.gear?.powerbankMah) missing.push('Elektronika a kapacita powerbanky.');
  plan.missingInfo = missing;

  plan.daySummaries = stages.map((st) => {
    const night = nights.find((n) => n.afterDay === st.index);
    const nightTxt = night ? `; nocleh: ${night.place?.name ?? 'v terénu'} (${LEGAL_CS[night.legalStatus]})` : '; cíl výpravy';
    return `Den ${st.index + 1}: ${kmStr(st.distanceM)} km, +${Math.round(st.ascentM)} m / −${Math.round(st.descentM)} m, pohyb ${hStr(st.movingMin)}${nightTxt}`;
  });

  plan.draft = buildDraft(plan);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const unavailableNoRoute = { status: 'skipped', reason: ONE_ROUTE_ATTEMPT_MSG } as const;

/**
 * Plan a complete expedition. Resolves even when individual ports fail;
 * only an aborted `signal` rejects.
 */
export async function planExpedition(request: ExpeditionRequest, ports: ToolPorts, opts: PlanOptions = {}): Promise<ExpeditionPlan> {
  const ctx: PlanContext = { ports, signal: opts.signal, onProgress: opts.onProgress, maxRouteOptions: opts.maxRouteOptions ?? 3 };
  const plan = emptyPlan(request, ports.now());

  await stepRegion(plan, ctx);
  if (plan.region.status === 'ok') {
    try {
      await selectRoute(plan, ctx);
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      plan.uncertainties.push(`Trasa: ${msgOf(e)}`);
    }
  }
  if (!plan.route) {
    Object.assign(plan, { stages: unavailableNoRoute, nights: unavailableNoRoute, water: unavailableNoRoute, weather: unavailableNoRoute, gear: unavailableNoRoute, food: unavailableNoRoute, power: unavailableNoRoute, itinerary: unavailableNoRoute });
    await stepGear(plan, ctx);
  } else {
    await stepStages(plan, ctx);
    await stepNights(plan, ctx);
    await stepWeather(plan, ctx);
    await stepWater(plan, ctx);
    await stepGear(plan, ctx);
    await stepFood(plan, ctx);
    await stepPower(plan, ctx);
    await stepItinerary(plan, ctx);
  }
  progress(ctx, 'finalize', 'Dokončuji plán…');
  const routeNote = plan.uncertainties.filter((u) => u.startsWith('Trasa:'));
  finalizePlan(plan);
  plan.uncertainties.unshift(...routeNote);
  return plan;
}

// ---------------------------------------------------------------------------
// Compact summary for the model
// ---------------------------------------------------------------------------

const status = (s: Section<unknown>): string => (s.status === 'ok' ? 'ok' : s.status === 'unavailable' ? `nedostupné (${s.code})` : `přeskočeno: ${s.reason}`);

/** Small, JSON-safe digest of a plan (no geometry) – what the model sees. */
export function summarizePlan(plan: ExpeditionPlan): Record<string, unknown> {
  const stages = plan.stages.status === 'ok' ? plan.stages.data : [];
  return {
    feasible: plan.feasible,
    explanation: plan.explanation,
    alternatives: plan.alternatives,
    region: plan.region.status === 'ok' ? plan.region.data.name : status(plan.region),
    chosenOptionId: plan.chosenOptionId,
    routeOptions: plan.routeOptions.map((o) => ({ id: o.id, label: o.label, distanceKm: o.distanceKm, ascentM: o.ascentM, fits: o.fits, deltaToTargetKm: o.deltaToTargetKm, chosen: o.chosen, warnings: o.warnings })),
    days: plan.daySummaries,
    stages: stages.map((s) => ({ day: s.index + 1, distanceKm: s.distanceM / 1000, ascentM: s.ascentM, movingMin: s.movingMin })),
    nights: plan.nights.status === 'ok' ? plan.nights.data.map((n) => ({ afterDay: n.afterDay + 1, place: n.place?.name, legalStatus: n.legalStatus, noLegalOption: n.noLegalOption, alternatives: n.alternatives.map((a) => a.label) })) : status(plan.nights),
    weather: plan.weather.status === 'ok' ? plan.weather.data.days : status(plan.weather),
    water: plan.water.status === 'ok' ? plan.water.data.map((d) => ({ day: d.day + 1, sources: d.sourcesCount, longestDryGapKm: d.longestDryGapKm, carryL: d.carryL, sufficient: d.sufficient })) : status(plan.water),
    gear: plan.gear.status === 'ok' ? { loadout: plan.gear.data.loadoutName, baseWeightG: plan.gear.data.baseWeightG, targetBaseWeightG: plan.gear.data.targetBaseWeightG, potentialSavingG: plan.gear.data.potentialSavingG } : status(plan.gear),
    food: plan.food.status === 'ok' ? { neededKcalPerDay: plan.food.data.neededKcalPerDay, plannedKcalPerDay: plan.food.data.plannedKcalPerDay, estimated: true } : status(plan.food),
    power: plan.power.status === 'ok' ? { sufficient: plan.power.data.sufficient, reservePct: plan.power.data.reservePct, estimated: true } : status(plan.power),
    advisories: plan.advisories.slice(0, 10).map((a) => ({ code: a.code, severity: a.severity, message: a.message, action: a.action })),
    uncertainties: plan.uncertainties,
    missingInfo: plan.missingInfo,
    checklist: plan.checklist.slice(0, 12).map((c) => c.text),
    draftReady: !!plan.draft,
    note: 'Nic nebylo uloženo. Pro uložení navrhněte createTrip a nechte uživatele potvrdit.',
  };
}
