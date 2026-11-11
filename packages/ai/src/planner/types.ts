/** Public types of the expedition planner. */
import type {
  ActivityType,
  BBox,
  FitnessLevel,
  LatLon,
  RoutePreference,
  SleepType,
  TripDay,
  TripSettings,
  LegalStatus,
} from '@trailpack/shared';
import type { CalcRecord, CampsiteResult, PeakResult, RouteOption, StageResult, WaterSourceResult } from '../tools/ports';
import type { RecommendationAdvisory } from '../recommendations/engine';

export interface NamedPoint {
  lat: number;
  lon: number;
  name?: string;
}

/** Fully specified input for `planExpedition`. Build it from text with `requestFromParsed`. */
export interface ExpeditionRequest {
  text?: string;
  region: { name: string; query?: string; countryCode?: string; bbox?: BBox };
  start?: NamedPoint;
  end?: NamedPoint;
  /** Extra via points to keep on the route. */
  viaPoints?: NamedPoint[];
  loop?: boolean;
  days: number;
  maxDailyKm: number;
  maxDailyAscentM?: number;
  activity: ActivityType;
  preference?: RoutePreference;
  sleepType: SleepType;
  excludeCampgrounds?: boolean;
  legalOnly?: boolean;
  avoidRain?: boolean;
  weatherAware?: boolean;
  startDate?: string;
  /** 'HH:MM', default 08:00 */
  startTime?: string;
  targetBaseWeightG?: number;
  fitness?: FitnessLevel;
  paceKmh?: number;
  people?: number;
  bodyWeightKg?: number;
  loadoutId?: string;
  gear?: { sleepingBagComfortC?: number; packVolumeL?: number; powerbankMah?: number };
  devices?: CalcRecord[];
  /** Whether a stove is used (affects regulation check). Default true. */
  stove?: boolean;
}

export type Section<T> =
  | { status: 'ok'; data: T; warnings?: string[] }
  | { status: 'unavailable'; code: string; message: string }
  | { status: 'skipped'; reason: string };

export interface RegionInfo {
  name: string;
  label?: string;
  bbox: BBox;
  center: LatLon;
  countryCode?: string;
  /** True when the bbox is an approximation around a point (geocoder returned none). */
  bboxEstimated: boolean;
}

export interface RouteOptionSummary {
  id: string;
  kind: string;
  label: string;
  distanceKm: number;
  ascentM: number;
  descentM: number;
  provider: string;
  warnings: string[];
  waypoints: NamedPoint[];
  /** Lower is better. */
  score: number;
  /** Fits the distance and ascent constraints. */
  fits: boolean;
  deltaToTargetKm: number;
  chosen: boolean;
}

export interface ChainInfo {
  kind: string;
  scale: number;
  waypoints: NamedPoint[];
}

export interface StagePlan extends StageResult {
  startKm: number;
  endKm: number;
  end: LatLon;
  startName?: string;
}

export interface AlternativeOption {
  kind: 'official_site' | 'other_sleep_type' | 'adjust_route';
  label: string;
  sleepType?: SleepType;
  campsiteId?: string;
  legalStatus?: LegalStatus;
}

export interface NightPlan {
  /** 0-based index of the day the night follows. */
  afterDay: number;
  lat: number;
  lon: number;
  place?: { id?: string; name?: string; type?: string; official: boolean };
  legalStatus: LegalStatus;
  /** Meets the legality requirement (verified_allowed, or conditional unless legalOnly). */
  acceptable: boolean;
  noLegalOption: boolean;
  protectedAreas: string[];
  countryCode?: string;
  disclaimer?: string;
  missingInfo: string[];
  /** Error code when the legality check itself failed (status stays 'unverified'). */
  checkError?: string;
  alternatives: AlternativeOption[];
  candidatesChecked: number;
}

export interface DayWater {
  day: number;
  sourcesCount: number;
  longestDryGapKm: number;
  carryL?: number;
  requiredL?: number;
  sufficient?: boolean;
  deficitL?: number;
  unknownPotability: number;
  calc?: CalcRecord;
  error?: string;
}

export interface WeatherDay {
  day: number;
  date?: string;
  tempMinC?: number;
  tempMaxC?: number;
  precipMaxProbPct?: number;
  precipSumMm?: number;
  windMaxKmh?: number;
  gustMaxKmh?: number;
  rainRisk: 'low' | 'medium' | 'high';
  samples: number;
  beyondHorizon: number;
  lowConfidence: boolean;
}

export interface WeatherPlan {
  days: WeatherDay[];
  /** Part of the trip lies beyond the forecast horizon. */
  partial: boolean;
  advisories: RecommendationAdvisory[];
}

export interface GearPlan {
  loadoutId: string;
  loadoutName: string;
  baseWeightG?: number;
  totalWeightG?: number;
  targetBaseWeightG?: number;
  overTargetG?: number;
  potentialSavingG?: number;
  suggestions: unknown[];
  weight?: CalcRecord;
}

export interface FoodPlan {
  neededKcalPerDay?: number;
  plannedKcalPerDay?: number;
  perDayKcal: number[];
  totalWeightG?: number;
  food?: CalcRecord;
  estimated: true;
}

export interface PowerPlan {
  sufficient?: boolean;
  reservePct?: number;
  result: CalcRecord;
  estimated: true;
}

export interface DayItinerary {
  day: number;
  date?: string;
  departure?: string;
  arrival?: string;
  sunrise?: string;
  sunset?: string;
  daylightReserveMin?: number;
  schedule?: CalcRecord;
}

export interface ChecklistEntry {
  category: 'safety' | 'legal' | 'water' | 'weather' | 'gear' | 'navigation' | 'power' | 'food';
  text: string;
  reason: string;
}

export interface ConstraintResult {
  key: 'distance' | 'ascent' | 'legal_nights' | 'base_weight' | 'weather';
  met: boolean;
  blocking: boolean;
  detail: string;
}

export type TripDayDraft = Omit<TripDay, 'id' | 'tripId' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

/** What the caller persists (after user confirmation) via TripsPort. */
export interface TripDraft {
  name: string;
  region: string;
  startDate?: string;
  endDate?: string;
  activityType: ActivityType;
  participantsCount: number;
  loadoutId?: string;
  routeOptionId?: string;
  settings: TripSettings;
  days: TripDayDraft[];
}

export interface PlanCache {
  campsites?: CampsiteResult[];
  waterSources?: WaterSourceResult[];
  peaks?: PeakResult[];
  campsitesError?: string;
  waterError?: string;
}

export interface ExpeditionPlan {
  request: ExpeditionRequest;
  generatedAt: string;
  region: Section<RegionInfo>;
  routeOptions: RouteOptionSummary[];
  chosenOptionId?: string;
  /** Chain (waypoints) behind the chosen route, used when recalculating. */
  chain?: ChainInfo;
  route?: RouteOption;
  stages: Section<StagePlan[]>;
  nights: Section<NightPlan[]>;
  water: Section<DayWater[]>;
  weather: Section<WeatherPlan>;
  gear: Section<GearPlan>;
  food: Section<FoodPlan>;
  power: Section<PowerPlan>;
  itinerary: Section<DayItinerary[]>;
  checklist: ChecklistEntry[];
  advisories: RecommendationAdvisory[];
  uncertainties: string[];
  daySummaries: string[];
  missingInfo: string[];
  feasible: boolean;
  /** Czech explanation of feasibility. */
  explanation: string;
  constraints: ConstraintResult[];
  alternatives: string[];
  draft?: TripDraft;
  cache: PlanCache;
}

export interface PlanProgress {
  step: string;
  index: number;
  total: number;
  message: string;
}

export interface PlanOptions {
  onProgress?: (p: PlanProgress) => void;
  signal?: AbortSignal;
  /** Max route alternatives to compare (default 3). */
  maxRouteOptions?: number;
}
