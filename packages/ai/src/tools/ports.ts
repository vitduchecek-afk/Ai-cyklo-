/**
 * Narrow ports (hexagonal architecture) used by AI tools, the expedition
 * planner and the recommendation engine. The application wires these to the
 * real services (routing, maps, weather, regulations, gear, nutrition,
 * database …); tests use in-memory fakes. Nothing in `@trailpack/ai` imports
 * those domain packages directly.
 */
import type {
  ActivityType,
  BBox,
  Campsite,
  GearItem,
  GearLoadout,
  HourlyWeather,
  LegalStatus,
  LoadoutItem,
  Position,
  ProtectedAreaInfo,
  RoutePreference,
  SleepType,
  WaterSource,
  WeatherForecast,
} from '@trailpack/shared';

/** Loosely typed payload for calculators whose real shapes live in other packages. */
export type CalcRecord = Record<string, unknown>;

export interface GeocodePlace {
  name: string;
  label: string;
  lat: number;
  lon: number;
  /** e.g. 'city', 'peak', 'region', 'street' */
  kind: string;
  bbox?: BBox;
  countryCode?: string;
}

export interface RouteRequest {
  waypoints: { lat: number; lon: number; name?: string }[];
  activity: ActivityType;
  preference: RoutePreference;
  alternatives?: number;
  /** Round trip generator: approximate loop length from the first waypoint. */
  roundTripLengthM?: number;
}

export interface RouteOption {
  id: string;
  geometry: Position[];
  distanceM: number;
  ascentM: number;
  descentM: number;
  provider: string;
  surfaceSummary: Record<string, number>;
  warnings: string[];
}

export interface ElevationProfileResult {
  points: { d: number; ele: number; gradePct: number }[];
  ascentM: number;
  descentM: number;
  minEle: number;
  maxEle: number;
}

export type ForecastResult = WeatherForecast & { stale: boolean; fetchedAt: string };

export interface RouteWeatherSample {
  label: string;
  kind: string;
  lat: number;
  lon: number;
  etaIso: string;
  hour?: HourlyWeather;
  confidence: 'high' | 'medium' | 'low';
  /** True when the ETA is outside the forecast horizon (no data). */
  beyondHorizon: boolean;
}

export type SearchArea = { bbox: BBox } | { routeGeometry: Position[]; corridorM: number };

export type CampsiteResult = Campsite & { distanceFromRouteM?: number; alongRouteM?: number };
export type WaterSourceResult = WaterSource & { distanceFromRouteM?: number; alongRouteM?: number };

export interface PeakResult {
  name: string;
  lat: number;
  lon: number;
  eleM: number;
}

export interface RegulationCheckInput {
  countryCode?: string;
  protectedAreas: ProtectedAreaInfo[];
  landType?: string;
  sleepType: SleepType;
  campfire?: boolean;
  stove?: boolean;
  placeLegalStatus?: LegalStatus;
}

export interface RegulationCheckResult {
  overall: LegalStatus;
  activityResults: unknown[];
  sources: unknown[];
  disclaimer: string;
  missingInfo: string[];
}

export interface LoadoutEntry {
  item: GearItem;
  entry: LoadoutItem;
}

export interface StageResult {
  index: number;
  fromIdx: number;
  toIdx: number;
  distanceM: number;
  ascentM: number;
  descentM: number;
  movingMin: number;
  endAnchorId?: string;
}

export interface StageAnchor {
  id: string;
  alongM: number;
  name?: string;
  type?: string;
  legalStatus?: LegalStatus;
}

export interface SplitStagesOptions {
  days: number;
  maxDailyKm: number;
  maxDailyAscentM?: number;
  paceKmh?: number;
  anchors: StageAnchor[];
  activity?: ActivityType;
}

/** Plain trip draft accepted by `trips.create` (id and timestamps are assigned by the repository). */
export type TripDraftInput = Record<string, unknown>;

export interface GearPort {
  listItems(): Promise<GearItem[]>;
  listLoadouts(): Promise<GearLoadout[]>;
  getLoadout(id: string): Promise<{ loadout: GearLoadout; entries: LoadoutEntry[] }>;
}

/**
 * Calculators. Results are loosely typed; the keys the planner reads are
 * documented per method (other keys are passed through to the model).
 */
export interface CalcPort {
  /** -> `{ baseWeightG, totalWeightG, wornWeightG?, consumableWeightG? }` */
  packWeight(entries: LoadoutEntry[]): Promise<CalcRecord>;
  /** -> `{ potentialSavingG, suggestions: [...] }` */
  optimizeGear(input: CalcRecord): Promise<CalcRecord>;
  /** -> `{ requiredL, carryL, sufficient?, deficitL? }` */
  waterNeeds(input: CalcRecord): Promise<CalcRecord>;
  /** -> `{ kcalPerDay, totalWeightG? }` */
  foodPlan(input: CalcRecord): Promise<CalcRecord>;
  /** -> `{ kcal }` (needed energy for the described day) */
  energy(input: CalcRecord): Promise<CalcRecord>;
  /** -> `{ sufficient, reservePct }` */
  power(input: CalcRecord): Promise<CalcRecord>;
  /** -> `{ movingMin }` */
  movingTime(input: CalcRecord): Promise<CalcRecord>;
  splitStages(geometry: Position[], opts: SplitStagesOptions): Promise<StageResult[]>;
  /** -> `{ departure?, arrival, totalMin? }` as 'HH:MM' strings */
  daySchedule(input: CalcRecord): Promise<CalcRecord>;
  /** -> `{ sunrise, sunset }` as 'HH:MM' local time or ISO strings */
  sunTimes(date: string, lat: number, lon: number): Promise<CalcRecord>;
}

export interface TripsPort {
  list(): Promise<Record<string, unknown>[]>;
  get(id: string): Promise<Record<string, unknown> | null>;
  create(draft: TripDraftInput): Promise<{ id: string } & Record<string, unknown>>;
  update(id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Persists a route option and returns the stored route id. */
  saveRoute(tripId: string, route: RouteOption, name: string): Promise<string>;
  saveDays(tripId: string, days: Record<string, unknown>[]): Promise<void>;
}

export interface OfflineRegionResult {
  regionId: string;
  estimatedSizeBytes: number;
  tileCount: number;
  status: string;
}

/** Everything AI tools can reach. */
export interface ToolPorts {
  geocode(query: string, opts?: { near?: { lat: number; lon: number }; limit?: number }): Promise<GeocodePlace[]>;
  reverseGeocode(lat: number, lon: number): Promise<GeocodePlace | null>;
  route(req: RouteRequest): Promise<RouteOption[]>;
  elevationProfile(geometry: Position[]): Promise<ElevationProfileResult>;
  forecast(lat: number, lon: number, days: number): Promise<ForecastResult>;
  weatherAlongRoute(geometry: Position[], startIso: string, stageEndsIdx?: number[]): Promise<RouteWeatherSample[]>;
  searchCampsites(area: SearchArea): Promise<CampsiteResult[]>;
  searchWaterSources(area: SearchArea): Promise<WaterSourceResult[]>;
  searchPeaks(bbox: BBox, limit: number): Promise<PeakResult[]>;
  protectedAreasAt(lat: number, lon: number): Promise<ProtectedAreaInfo[]>;
  detectCountry(lat: number, lon: number): Promise<{ countryCode: string; confidence: number }>;
  checkRegulations(input: RegulationCheckInput): Promise<RegulationCheckResult>;
  gear: GearPort;
  calc: CalcPort;
  trips: TripsPort;
  generateItinerary(tripId: string): Promise<unknown>;
  prepareOfflineRegion(input: { bbox: BBox; name: string; minZoom: number; maxZoom: number }): Promise<OfflineRegionResult>;
  exportGpx(input: { routeId?: string; tripId?: string }): Promise<{ fileName: string; uri?: string; bytes: number }>;
  getCurrentTrip(): Promise<Record<string, unknown> | null>;
  now(): Date;
  isOnline(): boolean;
}
