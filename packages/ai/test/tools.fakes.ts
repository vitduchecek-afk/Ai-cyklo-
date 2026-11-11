/** In-memory fake ports shared by tools / planner tests. */
import {
  CampsiteSchema,
  GearItemSchema,
  GearLoadoutSchema,
  LoadoutItemSchema,
  TrailPackError,
  WaterSourceSchema,
  type BBox,
  type LegalStatus,
  type Position,
  type SleepType,
} from '@trailpack/shared';
import { cumulativeDistances, lineLength } from '@trailpack/calculations';
import type { CampsiteResult, RegulationCheckInput, RouteOption, StageResult, ToolPorts, WaterSourceResult } from '../src/tools/ports';

export const NOW = new Date('2026-06-03T10:00:00Z');
const stamp = '2026-06-01T00:00:00.000Z';
const base = { createdAt: stamp, updatedAt: stamp };
const source = { provider: 'test', retrievedAt: stamp };

export interface FakeOptions {
  failWeather?: boolean;
  failRoute?: boolean;
  noPeaks?: boolean;
  campsites?: CampsiteResult[];
  waterSources?: WaterSourceResult[];
  /** Legal status for a sleep type; default: official types verified, wild conditional. */
  regulation?: (input: RegulationCheckInput) => LegalStatus;
  baseWeightG?: number;
  loadouts?: number;
  online?: boolean;
  /** Fixed stages instead of an even split. */
  stages?: StageResult[];
}

export const BESKYDY_BBOX: BBox = [18.0, 49.4, 19.2, 49.7];

export function makeCampsite(id: string, lon: number, type: CampsiteResult['type'], legalStatus: LegalStatus, alongRouteM?: number): CampsiteResult {
  return {
    ...CampsiteSchema.parse({ id, ...base, name: `Tábořiště ${id}`, type, lat: 49.55, lon, legalStatus, source }),
    alongRouteM,
    distanceFromRouteM: 200,
  };
}

export function makeWater(id: string, alongRouteM: number): WaterSourceResult {
  return { ...WaterSourceSchema.parse({ id, ...base, name: `Pramen ${id}`, type: 'spring', lat: 49.55, lon: 18.5, potability: 'treat', confidence: 'medium', source }), alongRouteM, distanceFromRouteM: 100 };
}

const PEAKS = Array.from({ length: 16 }, (_, i) => ({
  name: `Vrch ${i + 1}`,
  lat: 49.52 + ((i * 7) % 5) * 0.03,
  lon: 18.05 + i * 0.07,
  eleM: 800 + ((i * 37) % 9) * 60,
}));

/** Fake ports with a deterministic straight-line "router" (distance = haversine * 1.3). */
export function makeFakePorts(opts: FakeOptions = {}): ToolPorts & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const hit = (k: string): void => {
    calls[k] = (calls[k] ?? 0) + 1;
  };
  let routeSeq = 0;
  let tripSeq = 0;
  const stored: Record<string, Record<string, unknown>> = {};

  const item = GearItemSchema.parse({ id: 'i1', ...base, name: 'Stan', categoryKey: 'shelter', weightG: opts.baseWeightG ?? 3000 });
  const loadouts = Array.from({ length: opts.loadouts ?? 1 }, (_, i) => GearLoadoutSchema.parse({ id: `l${i + 1}`, ...base, name: `Sada ${i + 1}`, activityType: 'trekking', favorite: true }));
  const entry = LoadoutItemSchema.parse({ id: 'e1', ...base, loadoutId: 'l1', gearItemId: 'i1' });

  const reg = opts.regulation ?? ((i: RegulationCheckInput): LegalStatus => (['campground', 'mountain_hut', 'official_bivouac_site', 'paid_lodging'].includes(i.sleepType) ? 'verified_allowed' : 'conditional'));

  const ports: ToolPorts & { calls: Record<string, number> } = {
    calls,
    async geocode(query) {
      hit('geocode');
      if (/nikde/i.test(query)) return [];
      return [{ name: query, label: `${query}, Česko`, lat: 49.55, lon: 18.6, kind: 'region', bbox: BESKYDY_BBOX, countryCode: 'CZ' }];
    },
    async reverseGeocode(lat, lon) {
      hit('reverse');
      return { name: 'Pustevny', label: 'Pustevny', lat, lon, kind: 'locality' };
    },
    async route(req) {
      hit('route');
      if (opts.failRoute) throw new TrailPackError('no_route', 'Trasa nenalezena');
      const geometry: Position[] = [];
      req.waypoints.forEach((w, i) => {
        const prev = req.waypoints[i - 1];
        if (prev) for (let k = 1; k <= 8; k++) geometry.push([prev.lon + ((w.lon - prev.lon) * k) / 8, prev.lat + ((w.lat - prev.lat) * k) / 8, 600 + k]);
        else geometry.push([w.lon, w.lat, 600]);
      });
      const distanceM = lineLength(geometry) * 1.3;
      routeSeq += 1;
      const option: RouteOption = { id: `ro${routeSeq}`, geometry, distanceM, ascentM: distanceM / 1000 * 40, descentM: distanceM / 1000 * 38, provider: 'fake-router', surfaceSummary: { trail: 0.7, gravel: 0.3 }, warnings: [] };
      return [option];
    },
    async elevationProfile(geometry) {
      hit('elevation');
      const cum = cumulativeDistances(geometry);
      return { points: geometry.map((g, i) => ({ d: cum[i] ?? 0, ele: g[2] ?? 0, gradePct: i % 3 === 0 ? 8 : 2 })), ascentM: 500, descentM: 450, minEle: 600, maxEle: 1100 };
    },
    async forecast(lat, lon, days) {
      hit('forecast');
      return { lat, lon, timezone: 'Europe/Prague', provider: 'fake-wx', fetchedAt: stamp, hourly: [], daily: Array.from({ length: days }, (_, i) => ({ date: `2026-06-0${4 + i}`, tempMinC: 8, tempMaxC: 19, precipitationSumMm: 1, precipitationProbabilityMaxPct: 30, windSpeedMaxKmh: 15, windGustsMaxKmh: 30, uvIndexMax: 5, sunrise: '05:00', sunset: '21:00', weatherCode: 3 })), attribution: 'fake', stale: false };
    },
    async weatherAlongRoute(geometry, startIso, ends) {
      hit('weather');
      if (opts.failWeather) throw new TrailPackError('provider_error', 'Počasí nedostupné', { provider: 'fake-wx' });
      const start = Date.parse(startIso);
      const n = ends?.length ?? 3;
      return Array.from({ length: n }, (_, i) => {
        const p = geometry[Math.min(geometry.length - 1, ends?.[i] ?? 0)] ?? geometry[0]!;
        return {
          label: `Den ${i + 1}`,
          kind: 'stage_end',
          lat: p[1],
          lon: p[0],
          etaIso: new Date(start + i * 86400000 + 6 * 3600000).toISOString(),
          hour: { time: stamp, temperatureC: i === 1 ? 2 : 14, apparentTemperatureC: 12, humidityPct: 70, dewPointC: 5, precipitationMm: i === 2 ? 4 : 0, precipitationProbabilityPct: i === 2 ? 80 : 10, windSpeedKmh: 15, windGustsKmh: 30, windDirectionDeg: 200, cloudCoverPct: 50, uvIndex: 4, weatherCode: 3 },
          confidence: 'high' as const,
          beyondHorizon: false,
        };
      });
    },
    async searchCampsites() {
      hit('campsites');
      return opts.campsites ?? [];
    },
    async searchWaterSources() {
      hit('water');
      return opts.waterSources ?? [makeWater('w1', 5000), makeWater('w2', 30000), makeWater('w3', 60000)];
    },
    async searchPeaks() {
      hit('peaks');
      return opts.noPeaks ? [] : PEAKS;
    },
    async protectedAreasAt() {
      hit('areas');
      return [{ name: 'CHKO Beskydy', kind: 'protected_landscape_area' as const, countryCode: 'CZ' }];
    },
    async detectCountry() {
      hit('country');
      return { countryCode: 'CZ', confidence: 0.95 };
    },
    async checkRegulations(input) {
      hit('regulations');
      return { overall: reg(input), activityResults: [], sources: [{ name: 'test' }], disclaimer: 'Pravidla se mohou měnit.', missingInfo: [] };
    },
    gear: {
      async listItems() {
        return [item];
      },
      async listLoadouts() {
        return loadouts;
      },
      async getLoadout(id) {
        const loadout = loadouts.find((l) => l.id === id);
        if (!loadout) throw new TrailPackError('not_found', 'Sada nenalezena');
        return { loadout, entries: [{ item, entry }] };
      },
    },
    calc: {
      async packWeight(entries) {
        const w = entries.reduce((s, e) => s + e.item.weightG * e.entry.quantity, 0);
        return { baseWeightG: w, totalWeightG: w + 3500 };
      },
      async optimizeGear() {
        return { potentialSavingG: 600, suggestions: [{ text: 'Lehčí tarp' }] };
      },
      async waterNeeds(input) {
        const gap = Number(input['dryGapKm'] ?? 0);
        return { requiredL: Number(input['distanceKm']) * 0.25, carryL: gap * 0.15, sufficient: gap < 20, deficitL: gap < 20 ? 0 : 1.5 };
      },
      async foodPlan(input) {
        return { kcalPerDay: 3000, totalWeightG: 700 * Number(input['days']) };
      },
      async energy(input) {
        return { kcal: 2000 + Number(input['distanceKm']) * 60 + Number(input['ascentM']) * 0.8 };
      },
      async power() {
        return { sufficient: true, reservePct: 35 };
      },
      async movingTime(input) {
        return { movingMin: (Number(input['distanceM']) / 1000 / 4.5) * 60 };
      },
      async splitStages(geometry, o) {
        if (opts.stages) return opts.stages;
        const cum = cumulativeDistances(geometry);
        const total = cum[cum.length - 1] ?? 0;
        const last = geometry.length - 1;
        const stages: StageResult[] = [];
        let from = 0;
        for (let d = 1; d <= o.days; d++) {
          const targetAlong = (total * d) / o.days;
          let to = d === o.days ? last : cum.findIndex((c) => c >= targetAlong);
          if (to < 0) to = last;
          const dist = (cum[to] ?? 0) - (cum[from] ?? 0);
          const anchor = d < o.days ? o.anchors.find((a) => Math.abs(a.alongM - (cum[to] ?? 0)) < 1500) : undefined;
          stages.push({ index: d - 1, fromIdx: from, toIdx: to, distanceM: dist, ascentM: (dist / 1000) * 40, descentM: (dist / 1000) * 38, movingMin: (dist / 1000 / 4.5) * 60 + (dist / 1000) * 4, endAnchorId: anchor?.id });
          from = to;
        }
        return stages;
      },
      async daySchedule(input) {
        const start = String(input['startTime'] ?? '08:00');
        const [h, m] = start.split(':').map(Number) as [number, number];
        const total = h * 60 + m + Number(input['movingMin']) * 1.15;
        return { departure: start, arrival: `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(Math.round(total % 60)).padStart(2, '0')}` };
      },
      async sunTimes() {
        return { sunrise: '05:10', sunset: '21:05' };
      },
    },
    trips: {
      async list() {
        return Object.values(stored);
      },
      async get(id) {
        return stored[id] ?? null;
      },
      async create(draft) {
        tripSeq += 1;
        const id = `trip${tripSeq}`;
        stored[id] = { id, ...draft };
        return { id, ...draft };
      },
      async update(id, patch) {
        stored[id] = { ...(stored[id] ?? { id }), ...patch };
        return stored[id]!;
      },
      async saveRoute(tripId) {
        return `saved-${tripId}`;
      },
      async saveDays() {},
    },
    async generateItinerary(tripId) {
      return { tripId, days: 3 };
    },
    async prepareOfflineRegion(input) {
      hit('offline');
      return { regionId: 'reg1', estimatedSizeBytes: 52_428_800, tileCount: 4200, status: `queued:${input.name}` };
    },
    async exportGpx(input) {
      return { fileName: `${input.routeId ?? input.tripId}.gpx`, bytes: 1234 };
    },
    async getCurrentTrip() {
      return null;
    },
    now: () => NOW,
    isOnline: () => opts.online ?? true,
  };
  return ports;
}

export const sleepTypes: SleepType[] = ['tent', 'bivy_bag'];
