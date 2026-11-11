/**
 * Concrete AI tools. Each one validates input with zod, talks to the app only
 * through `ToolPorts` and returns compact, source-labelled data.
 */
import { z } from 'zod';
import {
  ActivityTypeSchema,
  RoutePreferenceSchema,
  SleepTypeSchema,
  parseCoordinates,
  type BBox,
  type Position,
} from '@trailpack/shared';
import { bboxOf, bufferBBox, lineLength } from '@trailpack/calculations';
import { parseTripRequest } from '../planner/parse';
import { planExpedition, requestFromParsed, summarizePlan } from '../planner/planner';
import type { ForecastResult, RouteOption, SearchArea, ToolPorts } from './ports';
import { buildToolExecutor, defineTool, ToolInputError, type AnyToolSpec, type RegistryExecutor, type ToolContext, type ToolExecutorOptions } from './registry';

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const lat = z.number().min(-90).max(90).describe('Latitude, WGS84 degrees');
const lon = z.number().min(-180).max(180).describe('Longitude, WGS84 degrees');
const bboxSchema = z.tuple([lon, lat, lon, lat]).describe('[west, south, east, north]');
const routeIdArg = z.string().min(1).describe('Short route id returned by calculateRoute (e.g. "rt1")');
const kmFmt = (m: number) => `${(m / 1000).toFixed(1).replace('.', ',')} km`;

const waypointSchema = z.union([
  z.object({ lat, lon, name: z.string().max(120).optional() }),
  z.object({ query: z.string().min(2).max(200).describe('Place name to geocode (resolved to the best match)') }),
]);

function geometryOf(ctx: ToolContext, routeId: string): Position[] {
  return ctx.routes.require(routeId).option.geometry;
}

function areaFrom(
  ctx: ToolContext,
  a: { routeId?: string; bbox?: BBox; lat?: number; lon?: number; radiusKm?: number; corridorM?: number },
): SearchArea {
  if (a.routeId) return { routeGeometry: geometryOf(ctx, a.routeId), corridorM: a.corridorM ?? 1500 };
  if (a.bbox) return { bbox: a.bbox };
  if (a.lat !== undefined && a.lon !== undefined) {
    return { bbox: bufferBBox(bboxOf([{ lat: a.lat, lon: a.lon }]), (a.radiusKm ?? 5) * 1000) };
  }
  throw new ToolInputError('Zadejte routeId, bbox, nebo lat+lon (s volitelným radiusKm).');
}

const areaFields = {
  routeId: routeIdArg.optional(),
  bbox: bboxSchema.optional(),
  lat: lat.optional(),
  lon: lon.optional(),
  radiusKm: z.number().min(0.1).max(50).optional().describe('Search radius around lat/lon, default 5 km'),
  corridorM: z.number().min(100).max(10000).optional().describe('Corridor half-width around a route, default 1500 m'),
};

function summariseRoute(id: string, o: RouteOption) {
  return {
    routeId: id,
    distanceKm: o.distanceM / 1000,
    ascentM: o.ascentM,
    descentM: o.descentM,
    provider: o.provider,
    surfaceSummary: o.surfaceSummary,
    warnings: o.warnings,
    points: o.geometry.length,
  };
}

function summariseForecast(f: ForecastResult) {
  return {
    provider: f.provider,
    model: f.model,
    fetchedAt: f.fetchedAt,
    stale: f.stale,
    attribution: f.attribution,
    daily: f.daily,
    // 3-hourly slice of the first 24 h keeps the payload small
    hourlyNext24h: f.hourly
      .slice(0, 24)
      .filter((_, i) => i % 3 === 0)
      .map((h) => ({
        time: h.time,
        tempC: h.temperatureC,
        precipMm: h.precipitationMm,
        precipProbPct: h.precipitationProbabilityPct,
        windKmh: h.windSpeedKmh,
        gustsKmh: h.windGustsKmh,
        code: h.weatherCode,
      })),
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const searchLocations = defineTool({
  name: 'searchLocations',
  description:
    'Search places by free text (towns, peaks, mountain ranges, huts, addresses). Returns several candidates with coordinates. Use when the user names a place and you need coordinates or to disambiguate; use geocodeLocation when you need exactly one resolved place.',
  schema: z.object({
    query: z.string().min(2).max(200),
    near: z.object({ lat, lon }).optional().describe('Bias results toward this point'),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  mutating: false,
  describe: (a) => `Hledání místa „${a.query}“`,
  async run(a, ports) {
    const places = await ports.geocode(a.query, { near: a.near, limit: a.limit });
    return { count: places.length, places, source: 'geocoder' };
  },
});

const geocodeLocation = defineTool({
  name: 'geocodeLocation',
  description:
    'Resolve ONE place: either a text query/coordinates string to a location (forward), or lat/lon to a place name (reverse). Use for turning "Lysá hora" into coordinates or coordinates into a readable name.',
  schema: z
    .object({
      query: z.string().min(2).max(200).optional().describe('Place name or coordinates like "49.546, 18.447"'),
      lat: lat.optional(),
      lon: lon.optional(),
    })
    .refine((v) => v.query !== undefined || (v.lat !== undefined && v.lon !== undefined), 'Zadejte query nebo lat+lon'),
  mutating: false,
  describe: (a) => (a.query ? `Určení polohy „${a.query}“` : 'Určení názvu místa podle souřadnic'),
  async run(a, ports) {
    if (a.query) {
      const c = parseCoordinates(a.query);
      if (c) {
        const rev = await ports.reverseGeocode(c.lat, c.lon).catch(() => null);
        return { place: rev ?? { name: a.query, label: a.query, lat: c.lat, lon: c.lon, kind: 'coordinates' }, parsedCoordinates: true };
      }
      const places = await ports.geocode(a.query, { limit: 3 });
      if (!places.length) return { place: null, message: `Místo „${a.query}“ nebylo nalezeno.` };
      return { place: places[0], alternatives: places.slice(1), source: 'geocoder' };
    }
    const place = await ports.reverseGeocode(a.lat!, a.lon!);
    return { place, source: 'geocoder' };
  },
});

const calculateRoute = defineTool({
  name: 'calculateRoute',
  description:
    'Compute one or more routes through waypoints (or a round trip) for an activity. Waypoints may be coordinates or place names. Returns short routeIds with distance/ascent/surface summary – geometry stays server-side and is referenced by routeId in other tools (compareRoutes, getElevationProfile, getWeatherAlongRoute, searchCampsites, searchWaterSources, exportGPX, createTrip).',
  schema: z
    .object({
      waypoints: z.array(waypointSchema).min(1).max(25),
      activity: ActivityTypeSchema.default('hiking'),
      preference: RoutePreferenceSchema.default('marked_trails'),
      alternatives: z.number().int().min(1).max(3).default(1).describe('Number of alternative routes'),
      roundTripLengthKm: z.number().min(1).max(500).optional().describe('Generate a loop of about this length from the first waypoint'),
    })
    .refine((v) => v.waypoints.length >= 2 || v.roundTripLengthKm !== undefined, 'Potřeba alespoň 2 body nebo roundTripLengthKm'),
  mutating: false,
  describe: (a) => `Výpočet trasy (${a.waypoints.length} bodů, ${a.activity})`,
  async run(a, ports, signal, ctx) {
    const resolved: { lat: number; lon: number; name?: string }[] = [];
    for (const w of a.waypoints) {
      if ('query' in w) {
        const found = await ports.geocode(w.query, { limit: 1 });
        const p = found[0];
        if (!p) throw new ToolInputError(`Místo „${w.query}“ nebylo nalezeno.`);
        resolved.push({ lat: p.lat, lon: p.lon, name: p.name });
      } else resolved.push(w);
      if (signal?.aborted) throw new ToolInputError('Přerušeno');
    }
    const options = await ports.route({
      waypoints: resolved,
      activity: a.activity,
      preference: a.preference,
      alternatives: a.alternatives,
      roundTripLengthM: a.roundTripLengthKm ? a.roundTripLengthKm * 1000 : undefined,
    });
    if (!options.length) throw new ToolInputError('Nebyla nalezena žádná trasa.');
    const routes = options.map((o) => summariseRoute(ctx.routes.add(o, a.activity, ctx.nowIso).id, o));
    return { routes, waypoints: resolved.map((w) => w.name ?? `${w.lat.toFixed(4)},${w.lon.toFixed(4)}`) };
  },
});

const compareRoutes = defineTool({
  name: 'compareRoutes',
  description:
    'Compare previously calculated routes (by routeId) on distance, ascent, ascent per km, surface mix, warnings and optional fit to a target distance. Use after calculateRoute returned alternatives.',
  schema: z.object({
    routeIds: z.array(routeIdArg).min(2).max(5),
    targetKm: z.number().min(1).max(1000).optional(),
    maxAscentM: z.number().min(0).max(20000).optional(),
  }),
  mutating: false,
  describe: (a) => `Porovnání tras ${a.routeIds.join(', ')}`,
  async run(a, ports, _signal, ctx) {
    const rows = await Promise.all(
      a.routeIds.map(async (id) => {
        const r = ctx.routes.require(id);
        const o = r.option;
        const km = o.distanceM / 1000;
        let movingMin: number | undefined;
        try {
          const mt = await ports.calc.movingTime({ distanceM: o.distanceM, ascentM: o.ascentM, descentM: o.descentM, activity: r.activity });
          movingMin = typeof mt['movingMin'] === 'number' ? (mt['movingMin'] as number) : undefined;
        } catch {
          /* optional */
        }
        return {
          routeId: id,
          distanceKm: km,
          ascentM: o.ascentM,
          descentM: o.descentM,
          ascentPerKm: km > 0 ? o.ascentM / km : 0,
          movingMin,
          deltaToTargetKm: a.targetKm !== undefined ? km - a.targetKm : undefined,
          overAscentLimit: a.maxAscentM !== undefined ? o.ascentM > a.maxAscentM : undefined,
          surfaceSummary: o.surfaceSummary,
          warnings: o.warnings,
          provider: o.provider,
        };
      }),
    );
    const best = a.targetKm !== undefined ? [...rows].sort((x, y) => Math.abs(x.deltaToTargetKm!) - Math.abs(y.deltaToTargetKm!))[0]?.routeId : undefined;
    return { routes: rows, closestToTarget: best, estimated: movingMin(rows) };
  },
});

function movingMin(rows: { movingMin?: number }[]): boolean {
  return rows.some((r) => r.movingMin !== undefined);
}

const getElevationProfile = defineTool({
  name: 'getElevationProfile',
  description: 'Elevation profile statistics and a downsampled profile (distance, elevation, grade) for a calculated route. Use to discuss climbs, steepest sections and min/max altitude.',
  schema: z.object({ routeId: routeIdArg, maxPoints: z.number().int().min(5).max(80).default(30) }),
  mutating: false,
  describe: (a) => `Výškový profil trasy ${a.routeId}`,
  async run(a, ports, _s, ctx) {
    const p = await ports.elevationProfile(geometryOf(ctx, a.routeId));
    const step = Math.max(1, Math.ceil(p.points.length / a.maxPoints));
    const points = p.points.filter((_, i) => i % step === 0 || i === p.points.length - 1);
    const steepest = [...p.points].sort((x, y) => Math.abs(y.gradePct) - Math.abs(x.gradePct))[0];
    return {
      ascentM: p.ascentM,
      descentM: p.descentM,
      minEleM: p.minEle,
      maxEleM: p.maxEle,
      steepest: steepest ? { atKm: steepest.d / 1000, gradePct: steepest.gradePct } : undefined,
      points: points.map((x) => ({ km: x.d / 1000, ele: x.ele, grade: x.gradePct })),
    };
  },
});

const getWeatherForecast = defineTool({
  name: 'getWeatherForecast',
  description: 'Weather forecast for a point: daily summary plus 3-hourly slice for the next 24 h. Reports provider, fetch time and whether data is stale (offline cache). Use for a single location; use getWeatherAlongRoute for a route.',
  schema: z.object({ lat, lon, days: z.number().int().min(1).max(10).default(3) }),
  mutating: false,
  describe: (a) => `Předpověď počasí pro ${a.lat.toFixed(3)}, ${a.lon.toFixed(3)}`,
  async run(a, ports) {
    return summariseForecast(await ports.forecast(a.lat, a.lon, a.days));
  },
});

const getWeatherAlongRoute = defineTool({
  name: 'getWeatherAlongRoute',
  description: 'Weather at estimated arrival times along a calculated route. Samples beyond the forecast horizon are flagged (no data is invented). Use to plan timing, rain avoidance and storm risk.',
  schema: z.object({
    routeId: routeIdArg,
    startTime: z.string().datetime({ offset: true }).optional().describe('ISO start time; default now'),
    stageEndsIdx: z.array(z.number().int().min(0)).max(30).optional().describe('Geometry indices where each day ends'),
  }),
  mutating: false,
  describe: (a) => `Počasí podél trasy ${a.routeId}`,
  async run(a, ports, _s, ctx) {
    const samples = await ports.weatherAlongRoute(geometryOf(ctx, a.routeId), a.startTime ?? ctx.nowIso, a.stageEndsIdx);
    const beyond = samples.filter((s) => s.beyondHorizon).length;
    return {
      samples: samples.slice(0, 30).map((s) => ({
        label: s.label,
        kind: s.kind,
        lat: s.lat,
        lon: s.lon,
        etaIso: s.etaIso,
        confidence: s.confidence,
        beyondHorizon: s.beyondHorizon,
        tempC: s.hour?.temperatureC,
        precipMm: s.hour?.precipitationMm,
        precipProbPct: s.hour?.precipitationProbabilityPct,
        windKmh: s.hour?.windSpeedKmh,
        gustsKmh: s.hour?.windGustsKmh,
        code: s.hour?.weatherCode,
      })),
      beyondHorizonCount: beyond,
      note: beyond > 0 ? 'Předpověď zatím není k dispozici pro část trasy (mimo horizont).' : undefined,
    };
  },
});

const searchCampsites = defineTool({
  name: 'searchCampsites',
  description: 'Find campsites, bivouac sites, shelters and huts along a route (routeId) or inside a bbox / around a point. Each result carries legalStatus and data source. Never claim a wild-camping spot is legal from this tool alone – use checkCampingRegulations.',
  schema: z.object({
    ...areaFields,
    types: z.array(z.string()).max(8).optional().describe('Filter by campsite type, e.g. ["campground","shelter"]'),
    onlyLegal: z.boolean().default(false).describe('Keep only legalStatus verified_allowed/conditional'),
    limit: z.number().int().min(1).max(40).default(20),
  }),
  mutating: false,
  describe: () => 'Hledání míst k přespání',
  async run(a, ports, _s, ctx) {
    let res = await ports.searchCampsites(areaFrom(ctx, a));
    if (a.types?.length) res = res.filter((c) => a.types!.includes(c.type));
    if (a.onlyLegal) res = res.filter((c) => c.legalStatus === 'verified_allowed' || c.legalStatus === 'conditional');
    res = [...res].sort((x, y) => (x.alongRouteM ?? 0) - (y.alongRouteM ?? 0));
    return {
      total: res.length,
      campsites: res.slice(0, a.limit).map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        lat: c.lat,
        lon: c.lon,
        eleM: c.eleM,
        legalStatus: c.legalStatus,
        legalNote: c.legalNote,
        water: c.water,
        toilets: c.toilets,
        fee: c.fee,
        reservation: c.reservation,
        distanceFromRouteM: c.distanceFromRouteM,
        alongRouteKm: c.alongRouteM !== undefined ? c.alongRouteM / 1000 : undefined,
        source: c.source.provider,
        retrievedAt: c.source.retrievedAt,
      })),
    };
  },
});

const searchWaterSources = defineTool({
  name: 'searchWaterSources',
  description: 'Find water sources (springs, wells, taps, streams) along a route or in an area, with potability and confidence. Treat "unknown"/low-confidence sources as needing treatment and say so.',
  schema: z.object({
    ...areaFields,
    limit: z.number().int().min(1).max(40).default(25),
  }),
  mutating: false,
  describe: () => 'Hledání zdrojů vody',
  async run(a, ports, _s, ctx) {
    const res = [...(await ports.searchWaterSources(areaFrom(ctx, a)))].sort((x, y) => (x.alongRouteM ?? 0) - (y.alongRouteM ?? 0));
    return {
      total: res.length,
      sources: res.slice(0, a.limit).map((w) => ({
        id: w.id,
        name: w.name,
        type: w.type,
        lat: w.lat,
        lon: w.lon,
        potability: w.potability,
        seasonal: w.seasonal,
        confidence: w.confidence,
        distanceFromRouteM: w.distanceFromRouteM,
        alongRouteKm: w.alongRouteM !== undefined ? w.alongRouteM / 1000 : undefined,
        source: w.source.provider,
        retrievedAt: w.source.retrievedAt,
      })),
    };
  },
});

const checkCampingRegulations = defineTool({
  name: 'checkCampingRegulations',
  description: 'Check whether sleeping (tent/tarp/open air/hammock/bivy), campfire or stove use is legal at a location. Resolves country and protected areas first, then evaluates regulations. Returns an overall status, sources, a disclaimer and missing info. Always relay the disclaimer; regulations may be outdated.',
  schema: z.object({
    lat,
    lon,
    sleepType: SleepTypeSchema,
    campfire: z.boolean().optional(),
    stove: z.boolean().optional(),
    landType: z.string().max(60).optional().describe('e.g. forest, meadow, private'),
  }),
  mutating: false,
  describe: (a) => `Kontrola pravidel pro nocování (${a.sleepType}) na ${a.lat.toFixed(3)}, ${a.lon.toFixed(3)}`,
  async run(a, ports) {
    const unresolved: string[] = [];
    const country = await ports.detectCountry(a.lat, a.lon).catch(() => {
      unresolved.push('Stát se nepodařilo určit.');
      return null;
    });
    const areas = await ports.protectedAreasAt(a.lat, a.lon).catch(() => {
      unresolved.push('Chráněná území se nepodařilo zjistit.');
      return [];
    });
    const res = await ports.checkRegulations({
      countryCode: country && country.confidence >= 0.5 ? country.countryCode : undefined,
      protectedAreas: areas,
      landType: a.landType,
      sleepType: a.sleepType,
      campfire: a.campfire,
      stove: a.stove,
    });
    return {
      countryCode: country?.countryCode,
      countryConfidence: country?.confidence,
      protectedAreas: areas.map((p) => ({ name: p.name, kind: p.kind, zone: p.zone, designation: p.designation })),
      overall: res.overall,
      activityResults: res.activityResults,
      sources: res.sources,
      disclaimer: res.disclaimer,
      missingInfo: [...res.missingInfo, ...unresolved],
    };
  },
});

const getGearInventory = defineTool({
  name: 'getGearInventory',
  description: 'Read the user\'s gear: all items (id, name, category, weight) and loadouts, or one loadout with its entries when loadoutId is given. Use before weight or gear advice.',
  schema: z.object({ loadoutId: z.string().optional(), limit: z.number().int().min(1).max(80).default(60) }),
  mutating: false,
  describe: (a) => (a.loadoutId ? 'Načtení sady vybavení' : 'Načtení inventáře vybavení'),
  async run(a, ports) {
    if (a.loadoutId) {
      const { loadout, entries } = await ports.gear.getLoadout(a.loadoutId);
      return {
        loadout: { id: loadout.id, name: loadout.name, targetBaseWeightG: loadout.targetBaseWeightG, packVolumeL: loadout.packVolumeL },
        entries: entries.slice(0, a.limit).map((e) => ({
          name: e.item.name,
          categoryKey: e.item.categoryKey,
          weightG: e.item.weightG,
          weightSource: e.item.weightSource,
          quantity: e.entry.quantity,
          carryMode: e.entry.carryMode,
        })),
        totalEntries: entries.length,
      };
    }
    const [items, loadouts] = await Promise.all([ports.gear.listItems(), ports.gear.listLoadouts()]);
    return {
      totalItems: items.length,
      items: items.slice(0, a.limit).map((i) => ({ id: i.id, name: i.name, categoryKey: i.categoryKey, weightG: i.weightG, weightSource: i.weightSource, essential: i.essential })),
      loadouts: loadouts.map((l) => ({ id: l.id, name: l.name, activityType: l.activityType, season: l.season, targetBaseWeightG: l.targetBaseWeightG })),
    };
  },
});

const calculatePackWeight = defineTool({
  name: 'calculatePackWeight',
  description: 'Compute base/worn/consumable/total weight of a gear loadout and compare it with a target base weight.',
  schema: z.object({ loadoutId: z.string().min(1), targetBaseWeightG: z.number().int().positive().optional() }),
  mutating: false,
  describe: () => 'Výpočet hmotnosti batohu',
  async run(a, ports) {
    const { loadout, entries } = await ports.gear.getLoadout(a.loadoutId);
    const res = await ports.calc.packWeight(entries);
    const base = (res['baseWeightG'] ?? res['baseG']) as number | undefined;
    const target = a.targetBaseWeightG ?? loadout.targetBaseWeightG;
    return { loadout: loadout.name, ...res, targetBaseWeightG: target, overTargetG: target !== undefined && typeof base === 'number' ? Math.max(0, base - target) : undefined };
  },
});

const optimizeGear = defineTool({
  name: 'optimizeGear',
  description: 'Suggest weight savings for a loadout (swaps, removals, lighter alternatives) toward a target base weight. Safety-critical items are never suggested for removal. Suggestions are advice, nothing is changed.',
  schema: z.object({
    loadoutId: z.string().min(1),
    targetBaseWeightG: z.number().int().positive().optional(),
    activity: ActivityTypeSchema.optional(),
    days: z.number().int().min(1).max(60).optional(),
  }),
  mutating: false,
  describe: () => 'Optimalizace vybavení',
  async run(a, ports) {
    const { loadout, entries } = await ports.gear.getLoadout(a.loadoutId);
    return ports.calc.optimizeGear({
      entries,
      loadout,
      targetBaseWeightG: a.targetBaseWeightG ?? loadout.targetBaseWeightG,
      activity: a.activity,
      days: a.days,
    });
  },
});

const calculateWaterNeeds = defineTool({
  name: 'calculateWaterNeeds',
  description: 'Estimate drinking-water need and how much to carry between sources for a day (distance, ascent, temperature, sources along the way). Result is an estimate.',
  schema: z.object({
    distanceKm: z.number().min(0.1).max(300),
    ascentM: z.number().min(0).max(10000).default(0),
    tempC: z.number().min(-30).max(50).optional(),
    durationHours: z.number().min(0.1).max(24).optional(),
    bodyWeightKg: z.number().min(20).max(250).optional(),
    sourcesAlongKm: z.array(z.number().min(0)).max(40).optional().describe('Positions (km from day start) of reliable water sources'),
  }),
  mutating: false,
  describe: (a) => `Výpočet potřeby vody (${a.distanceKm} km)`,
  async run(a, ports) {
    return { ...(await ports.calc.waterNeeds(a)), estimated: true };
  },
});

const calculateFoodNeeds = defineTool({
  name: 'calculateFoodNeeds',
  description: 'Estimate daily energy expenditure and a food plan (kcal/day, weight) for a trip. Result is an estimate.',
  schema: z.object({
    days: z.number().int().min(1).max(60),
    distanceKmPerDay: z.number().min(0).max(300),
    ascentMPerDay: z.number().min(0).max(10000).default(0),
    bodyWeightKg: z.number().min(20).max(250).optional(),
    packWeightKg: z.number().min(0).max(60).optional(),
    people: z.number().int().min(1).max(20).default(1),
  }),
  mutating: false,
  describe: (a) => `Výpočet jídla na ${a.days} dní`,
  async run(a, ports) {
    const energy = await ports.calc.energy({ distanceKm: a.distanceKmPerDay, ascentM: a.ascentMPerDay, bodyWeightKg: a.bodyWeightKg, packWeightKg: a.packWeightKg });
    const food = await ports.calc.foodPlan({ ...a, energy });
    return { energy, food, estimated: true };
  },
});

const calculatePowerRequirements = defineTool({
  name: 'calculatePowerRequirements',
  description: 'Check whether power banks / solar cover the electronics (phone, GPS, headlamp …) for the trip and the remaining reserve in percent.',
  schema: z.object({
    days: z.number().int().min(1).max(60),
    devices: z
      .array(z.object({ name: z.string().max(60), batteryMah: z.number().positive().optional(), batteryWh: z.number().positive().optional(), dailyUseHours: z.number().min(0).max(24).optional() }))
      .max(15)
      .default([]),
    powerbankMah: z.number().positive().optional(),
    powerbankWh: z.number().positive().optional(),
    solarW: z.number().min(0).max(200).optional(),
  }),
  mutating: false,
  describe: (a) => `Výpočet napájení na ${a.days} dní`,
  async run(a, ports) {
    return { ...(await ports.calc.power(a)), estimated: true };
  },
});

const tripFields = {
  name: z.string().min(1).max(200),
  region: z.string().max(200).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  activityType: ActivityTypeSchema.optional(),
  participantsCount: z.number().int().min(1).max(100).optional(),
  description: z.string().max(5000).optional(),
  loadoutId: z.string().optional(),
  settings: z
    .object({
      dailyDistanceKm: z.number().min(1).max(400).optional(),
      maxDailyAscentM: z.number().min(0).max(10000).optional(),
      sleepType: SleepTypeSchema.optional(),
      targetBaseWeightG: z.number().int().positive().optional(),
      avoidRain: z.boolean().optional(),
      startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    })
    .optional(),
};

const createTrip = defineTool({
  name: 'createTrip',
  description: 'Create a new trip in the user\'s library, optionally attaching a calculated route (routeId). Requires user confirmation. Use only after the user agreed to save the plan.',
  schema: z.object({ ...tripFields, routeId: routeIdArg.optional() }),
  mutating: true,
  describe: (a) => `Vytvořit výpravu „${a.name}“${a.routeId ? ' s vypočtenou trasou' : ''}`,
  async run(a, ports, _s, ctx) {
    const { routeId, ...draft } = a;
    const trip = await ports.trips.create({ ...draft, status: 'planning' });
    let savedRouteId: string | undefined;
    if (routeId) {
      const cached = ctx.routes.require(routeId);
      savedRouteId = await ports.trips.saveRoute(trip.id, cached.option, cached.name ?? a.name);
      cached.persistedRouteId = savedRouteId;
      await ports.trips.update(trip.id, { routeId: savedRouteId });
    }
    return { tripId: trip.id, savedRouteId, message: `Výprava „${a.name}“ byla vytvořena.` };
  },
});

const updateTrip = defineTool({
  name: 'updateTrip',
  description: 'Update fields of an existing trip (name, dates, settings …). Requires user confirmation.',
  schema: z.object({ tripId: z.string().min(1), patch: z.object(tripFields).partial().refine((p) => Object.keys(p).length > 0, 'Prázdná změna') }),
  mutating: true,
  describe: (a) => `Upravit výpravu: ${Object.keys(a.patch).join(', ')}`,
  async run(a, ports) {
    const updated = await ports.trips.update(a.tripId, a.patch);
    return { tripId: a.tripId, updatedFields: Object.keys(a.patch), trip: updated };
  },
});

const generateItinerary = defineTool({
  name: 'generateItinerary',
  description: 'Generate the day-by-day itinerary (stages, timing, sunset reserve) for an existing trip that has a route. Returns the itinerary; it does not modify the trip.',
  schema: z.object({ tripId: z.string().min(1) }),
  mutating: false,
  describe: () => 'Generování itineráře',
  async run(a, ports) {
    return { itinerary: await ports.generateItinerary(a.tripId) };
  },
});

const prepareOfflineRegion = defineTool({
  name: 'prepareOfflineRegion',
  description: 'Download offline map tiles for an area (bbox, or the corridor of a calculated route). Uses network and storage – requires user confirmation. Fails when the device is offline.',
  schema: z
    .object({
      name: z.string().min(1).max(120),
      bbox: bboxSchema.optional(),
      routeId: routeIdArg.optional(),
      bufferKm: z.number().min(0).max(30).default(3),
      minZoom: z.number().int().min(0).max(18).default(8),
      maxZoom: z.number().int().min(0).max(18).default(15),
    })
    .refine((v) => v.bbox || v.routeId, 'Zadejte bbox nebo routeId')
    .refine((v) => v.minZoom <= v.maxZoom, 'minZoom musí být <= maxZoom'),
  mutating: true,
  describe: (a) => `Stáhnout offline mapy „${a.name}“ (zoom ${a.minZoom}–${a.maxZoom})`,
  async run(a, ports, _s, ctx) {
    if (!ports.isOnline()) throw new ToolInputError('Zařízení je offline – stahování map není možné.');
    const base: BBox = a.bbox ?? bboxOf(geometryOf(ctx, a.routeId!));
    const bbox = a.routeId ? bufferBBox(base, a.bufferKm * 1000) : base;
    const res = await ports.prepareOfflineRegion({ bbox, name: a.name, minZoom: a.minZoom, maxZoom: a.maxZoom });
    return { ...res, estimatedSizeMB: res.estimatedSizeBytes / 1_048_576, estimated: true };
  },
});

const exportGPX = defineTool({
  name: 'exportGPX',
  description: 'Export a route or a whole trip as a GPX file. A calculated route must first be saved with createTrip; saved route ids and tripIds are accepted directly.',
  schema: z.object({ routeId: z.string().optional(), tripId: z.string().optional() }).refine((v) => v.routeId || v.tripId, 'Zadejte routeId nebo tripId'),
  mutating: false,
  describe: () => 'Export GPX',
  async run(a, ports, _s, ctx) {
    let routeId = a.routeId;
    if (routeId) {
      const cached = ctx.routes.get(routeId);
      if (cached) {
        if (!cached.persistedRouteId) throw new ToolInputError('Trasa ještě není uložena. Nejprve vytvořte výpravu (createTrip) s touto trasou.');
        routeId = cached.persistedRouteId;
      }
    }
    return ports.exportGpx({ routeId, tripId: a.tripId });
  },
});

const getCurrentTrip = defineTool({
  name: 'getCurrentTrip',
  description: 'Return the trip currently open/active in the app (or null). Use when the user says "my trip" without naming it.',
  schema: z.object({}),
  mutating: false,
  describe: () => 'Načtení aktuální výpravy',
  async run(_a, ports) {
    const trip = await ports.getCurrentTrip();
    return trip ? { hasTrip: true, trip } : { hasTrip: false, message: 'Žádná výprava není právě otevřená.' };
  },
});

const planExpeditionTool = defineTool({
  name: 'planExpedition',
  description:
    'Plan a whole multi-day expedition from a natural-language request: parses constraints (days, km/day, sleep type, base weight, dates, region), finds route options, splits stages, checks legality of each night, water, weather, gear, food, power, itinerary and risks. Returns a compact summary and a routeId; nothing is saved. Use when the user asks to plan a complete trip. If key facts are missing it returns follow-up questions instead.',
  schema: z.object({
    request: z.string().min(5).max(4000).describe('The user\'s request, verbatim'),
    overrides: z
      .object({
        region: z.string().max(120).optional(),
        days: z.number().int().min(1).max(30).optional(),
        maxDailyKm: z.number().min(3).max(200).optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        sleepType: SleepTypeSchema.optional(),
        targetBaseWeightG: z.number().int().positive().optional(),
        loadoutId: z.string().optional(),
      })
      .optional(),
  }),
  mutating: true,
  describe: (a) => `Naplánovat celou výpravu: „${a.request.slice(0, 80)}${a.request.length > 80 ? '…' : ''}“`,
  async run(a, ports, signal, ctx) {
    const parsed = parseTripRequest(a.request, ports.now());
    const o = a.overrides ?? {};
    const fields = {
      ...parsed.fields,
      ...(o.region ? { region: o.region, regionQuery: o.region } : {}),
      ...(o.days ? { days: o.days } : {}),
      ...(o.maxDailyKm ? { maxDailyKm: o.maxDailyKm } : {}),
      ...(o.startDate ? { startDate: o.startDate } : {}),
      ...(o.sleepType ? { sleepType: o.sleepType } : {}),
      ...(o.targetBaseWeightG ? { targetBaseWeightG: o.targetBaseWeightG } : {}),
    };
    if (!fields.region && !fields.regionQuery) {
      return { needsMoreInfo: true, questions: ['V jaké oblasti nebo mezi jakými místy chcete jet / jít?', ...parsed.missing.filter((m) => !/oblast|region/i.test(m))], understood: fields };
    }
    const request = requestFromParsed({ ...parsed, fields }, { loadoutId: o.loadoutId });
    const plan = await planExpedition(request, ports, { signal });
    let routeId: string | undefined;
    if (plan.route) {
      routeId = ctx.routes.add(plan.route, request.activity, ctx.nowIso, plan.draft?.name).id;
    }
    return { routeId, ...summarizePlan(plan), distance: plan.route ? kmFmt(lineLength(plan.route.geometry)) : undefined };
  },
});

/** All built-in tools, in the order shown to the model. */
export const ALL_TOOLS: readonly AnyToolSpec[] = [
  searchLocations,
  geocodeLocation,
  calculateRoute,
  compareRoutes,
  getElevationProfile,
  getWeatherForecast,
  getWeatherAlongRoute,
  searchCampsites,
  searchWaterSources,
  checkCampingRegulations,
  getGearInventory,
  calculatePackWeight,
  optimizeGear,
  calculateWaterNeeds,
  calculateFoodNeeds,
  calculatePowerRequirements,
  createTrip,
  updateTrip,
  generateItinerary,
  prepareOfflineRegion,
  exportGPX,
  getCurrentTrip,
  planExpeditionTool,
];

/** Create the executor with all (or `enabled`) built-in tools bound to the given ports. */
export function createToolExecutor(ports: ToolPorts, opts: ToolExecutorOptions = {}): RegistryExecutor {
  return buildToolExecutor(ports, ALL_TOOLS, opts);
}
