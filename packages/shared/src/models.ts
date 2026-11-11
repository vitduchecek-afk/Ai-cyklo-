/**
 * TrailPack domain models.
 *
 * Every persisted entity is described by a zod schema; the TypeScript type is
 * inferred from it. Schemas are the single source of truth used by the
 * database layer, sync layer, import/export and AI tool validation.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const IdSchema = z.string().min(1).max(64);
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
/** Calendar date `YYYY-MM-DD`. */
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
/** Local time `HH:MM`. */
export const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 currency code');

export const LatSchema = z.number().min(-90).max(90);
export const LonSchema = z.number().min(-180).max(180);

export const LatLonSchema = z.object({ lat: LatSchema, lon: LonSchema });
export type LatLon = z.infer<typeof LatLonSchema>;

/** GeoJSON position: [lon, lat] or [lon, lat, elevationMeters]. */
export const PositionSchema = z.union([
  z.tuple([LonSchema, LatSchema]),
  z.tuple([LonSchema, LatSchema, z.number()]),
]);
export type Position = [number, number] | [number, number, number];

/** Bounding box [west, south, east, north]. */
export const BBoxSchema = z.tuple([LonSchema, LatSchema, LonSchema, LatSchema]);
export type BBox = [number, number, number, number];

export const TrackPointSchema = z.object({
  lat: LatSchema,
  lon: LonSchema,
  ele: z.number().optional(),
  /** epoch milliseconds */
  time: z.number().optional(),
  accuracy: z.number().nonnegative().optional(),
  speed: z.number().optional(),
});
export type TrackPoint = z.infer<typeof TrackPointSchema>;

/** Fields shared by every synced entity. */
export const EntityBaseSchema = z.object({
  id: IdSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  /** Soft delete marker (tombstone) used by sync. */
  deletedAt: IsoDateTimeSchema.nullable().optional(),
});
export type EntityBase = z.infer<typeof EntityBaseSchema>;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const ActivityTypeSchema = z.enum([
  'hiking',
  'trekking',
  'ultralight',
  'ridge_traverse',
  'multi_day',
  'day_hike',
  'family',
  'camping',
  'bivouac',
  'bikepacking',
  'gravel',
  'mtb',
  'xc',
  'road_cycling',
]);
export type ActivityType = z.infer<typeof ActivityTypeSchema>;

export const CYCLING_ACTIVITIES: readonly ActivityType[] = ['bikepacking', 'gravel', 'mtb', 'xc', 'road_cycling'];
export const isCyclingActivity = (a: ActivityType): boolean => CYCLING_ACTIVITIES.includes(a);

export const FitnessLevelSchema = z.enum(['low', 'moderate', 'good', 'excellent']);
export type FitnessLevel = z.infer<typeof FitnessLevelSchema>;

export const ExperienceLevelSchema = z.enum(['beginner', 'intermediate', 'advanced', 'expert']);
export type ExperienceLevel = z.infer<typeof ExperienceLevelSchema>;

export const SleepTypeSchema = z.enum([
  'open_air',
  'tarp',
  'tent',
  'hammock',
  'bivy_bag',
  'shelter',
  'emergency_hut',
  'official_bivouac_site',
  'campground',
  'mountain_hut',
  'paid_lodging',
]);
export type SleepType = z.infer<typeof SleepTypeSchema>;

export const SurfacePreferenceSchema = z.enum(['any', 'paved', 'gravel', 'trail', 'avoid_paved']);
export type SurfacePreference = z.infer<typeof SurfacePreferenceSchema>;

export const RoutePreferenceSchema = z.enum([
  'shortest',
  'fastest',
  'easiest',
  'least_ascent',
  'marked_trails',
  'nature',
  'scenic',
]);
export type RoutePreference = z.infer<typeof RoutePreferenceSchema>;

export const UnitsSchema = z.enum(['metric', 'imperial']);
export type Units = z.infer<typeof UnitsSchema>;

export const LanguageSchema = z.enum(['cs', 'en', 'sk', 'pl', 'de']);
export type Language = z.infer<typeof LanguageSchema>;

export const SeveritySchema = z.enum(['info', 'warning', 'danger']);
export type Severity = z.infer<typeof SeveritySchema>;

// ---------------------------------------------------------------------------
// User profile & settings
// ---------------------------------------------------------------------------

export const EmergencyContactSchema = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().min(3).max(40),
  relation: z.string().max(80).optional(),
});
export type EmergencyContact = z.infer<typeof EmergencyContactSchema>;

export const UserProfileSchema = EntityBaseSchema.extend({
  displayName: z.string().max(120).optional(),
  language: LanguageSchema.default('cs'),
  units: UnitsSchema.default('metric'),
  currency: CurrencySchema.default('CZK'),
  experienceLevel: ExperienceLevelSchema.default('intermediate'),
  fitness: FitnessLevelSchema.default('moderate'),
  /** Typical walking speed on flat terrain, km/h. */
  typicalPaceKmh: z.number().min(1).max(40).default(4.5),
  preferredDailyDistanceKm: z.number().min(1).max(400).default(20),
  maxDailyAscentM: z.number().min(0).max(10000).default(1200),
  favoriteActivities: z.array(ActivityTypeSchema).default([]),
  sleepPreferences: z.array(SleepTypeSchema).default([]),
  preferredMapStyle: z.string().default('outdoor'),
  budgetPerTrip: z.number().nonnegative().optional(),
  baseWeightTargetG: z.number().int().positive().optional(),
  weatherPreferences: z
    .object({
      avoidRain: z.boolean().default(false),
      maxWindKmh: z.number().positive().optional(),
      minNightTempC: z.number().optional(),
    })
    .default({ avoidRain: false }),
  emergencyContacts: z.array(EmergencyContactSchema).default([]),
  /** Voluntary. Used only to refine water/energy estimates. */
  bodyWeightKg: z.number().min(20).max(250).optional(),
  emergencyInfo: z.string().max(2000).optional(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const ThemeModeSchema = z.enum(['system', 'light', 'dark', 'outdoor']);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;

export const AiModeSchema = z.enum(['off', 'proxy', 'direct']);
export type AiMode = z.infer<typeof AiModeSchema>;

export const AiProviderIdSchema = z.enum(['openai', 'anthropic', 'gemini', 'openai_compatible']);
export type AiProviderId = z.infer<typeof AiProviderIdSchema>;

export const RoutingProviderIdSchema = z.enum(['brouter', 'valhalla', 'openrouteservice', 'graphhopper', 'mapy']);
export type RoutingProviderId = z.infer<typeof RoutingProviderIdSchema>;

export const GeocoderProviderIdSchema = z.enum(['photon', 'nominatim', 'mapy']);
export type GeocoderProviderId = z.infer<typeof GeocoderProviderIdSchema>;

export const DashboardCardSchema = z.enum([
  'next_trip',
  'weather',
  'pack_weight',
  'stats',
  'checklist',
  'quick_actions',
  'safety',
  'recommendations',
]);
export type DashboardCard = z.infer<typeof DashboardCardSchema>;

export const AppSettingsSchema = z.object({
  theme: ThemeModeSchema.default('system'),
  language: LanguageSchema.default('cs'),
  units: UnitsSchema.default('metric'),
  currency: CurrencySchema.default('CZK'),
  mapStyleId: z.string().default('outdoor'),
  overlayIds: z.array(z.string()).default(['hiking_trails']),
  routingProvider: RoutingProviderIdSchema.default('brouter'),
  geocoderProvider: GeocoderProviderIdSchema.default('photon'),
  weatherProvider: z.enum(['open-meteo']).default('open-meteo'),
  aiMode: AiModeSchema.default('off'),
  aiProvider: AiProviderIdSchema.default('anthropic'),
  aiModel: z.string().default(''),
  aiBaseUrl: z.string().url().optional(),
  apiBaseUrl: z.string().url().optional(),
  aiMonthlyBudgetUsd: z.number().nonnegative().default(5),
  syncEnabled: z.boolean().default(false),
  dashboardCards: z.array(DashboardCardSchema).default([
    'next_trip',
    'quick_actions',
    'weather',
    'pack_weight',
    'recommendations',
    'stats',
  ]),
  voiceEnabled: z.boolean().default(true),
  hapticsEnabled: z.boolean().default(true),
  fontScale: z.number().min(0.8).max(1.6).default(1),
  offRouteThresholdM: z.number().min(10).max(1000).default(60),
  gpsIntervalMs: z.number().int().min(1000).max(60000).default(3000),
  autoPauseEnabled: z.boolean().default(true),
  notifications: z
    .object({
      tripReminders: z.boolean().default(true),
      checklist: z.boolean().default(true),
      offlineMaps: z.boolean().default(true),
      sunset: z.boolean().default(true),
      offRoute: z.boolean().default(true),
    })
    .default({ tripReminders: true, checklist: true, offlineMaps: true, sunset: true, offRoute: true }),
  onboardingDone: z.boolean().default(false),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;
export const DEFAULT_SETTINGS: AppSettings = AppSettingsSchema.parse({});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const WaypointTypeSchema = z.enum(['start', 'via', 'end', 'poi', 'camp', 'water', 'avoid']);
export type WaypointType = z.infer<typeof WaypointTypeSchema>;

export const RouteWaypointSchema = z.object({
  id: IdSchema,
  order: z.number().int().nonnegative(),
  lat: LatSchema,
  lon: LonSchema,
  name: z.string().max(200).optional(),
  type: WaypointTypeSchema.default('via'),
});
export type RouteWaypoint = z.infer<typeof RouteWaypointSchema>;

export const RouteSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  /** index into route geometry */
  fromIdx: z.number().int().nonnegative(),
  toIdx: z.number().int().nonnegative(),
  distanceM: z.number().nonnegative(),
  ascentM: z.number().nonnegative(),
  descentM: z.number().nonnegative(),
  surface: z.string().optional(),
  wayType: z.string().optional(),
  gradePct: z.number().optional(),
});
export type RouteSegment = z.infer<typeof RouteSegmentSchema>;

export const RouteSourceSchema = z.enum([
  'brouter',
  'valhalla',
  'openrouteservice',
  'graphhopper',
  'mapy',
  'import',
  'manual',
  'recording',
]);
export type RouteSource = z.infer<typeof RouteSourceSchema>;

export const RouteSchema = EntityBaseSchema.extend({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  activityType: ActivityTypeSchema.default('hiking'),
  source: RouteSourceSchema,
  profile: z.string().optional(),
  geometry: z.array(PositionSchema).min(2),
  waypoints: z.array(RouteWaypointSchema).default([]),
  segments: z.array(RouteSegmentSchema).default([]),
  distanceM: z.number().nonnegative(),
  ascentM: z.number().nonnegative(),
  descentM: z.number().nonnegative(),
  minEleM: z.number().optional(),
  maxEleM: z.number().optional(),
  surfaceSummary: z.record(z.string(), z.number()).default({}),
  isLoop: z.boolean().default(false),
  favorite: z.boolean().default(false),
  tripId: IdSchema.nullable().optional(),
  attribution: z.string().optional(),
});
export type Route = z.infer<typeof RouteSchema>;

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

export const TripStatusSchema = z.enum(['idea', 'planning', 'ready', 'active', 'completed', 'cancelled']);
export type TripStatus = z.infer<typeof TripStatusSchema>;

export const TripSettingsSchema = z.object({
  startTime: LocalTimeSchema.default('08:00'),
  dailyDistanceKm: z.number().min(1).max(400).default(20),
  maxDailyAscentM: z.number().min(0).max(10000).default(1200),
  fitness: FitnessLevelSchema.default('moderate'),
  paceKmh: z.number().min(1).max(40).default(4.5),
  sleepType: SleepTypeSchema.default('tent'),
  surface: SurfacePreferenceSchema.default('any'),
  routePreference: RoutePreferenceSchema.default('marked_trails'),
  breakMinutesPerHour: z.number().min(0).max(30).default(10),
  targetBaseWeightG: z.number().int().positive().optional(),
  avoidRain: z.boolean().default(false),
  stoveType: z.enum(['gas', 'liquid', 'alcohol', 'none', 'cold_soak']).default('gas'),
});
export type TripSettings = z.infer<typeof TripSettingsSchema>;

export const TransportModeSchema = z.enum(['car', 'train', 'bus', 'bike', 'walk', 'combined']);
export type TransportMode = z.infer<typeof TransportModeSchema>;

export const TransportLegSchema = z.object({
  id: IdSchema,
  direction: z.enum(['outbound', 'return']),
  mode: TransportModeSchema,
  from: z.string().max(200),
  to: z.string().max(200),
  departure: IsoDateTimeSchema.optional(),
  arrival: IsoDateTimeSchema.optional(),
  parking: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
  costEstimate: z.number().nonnegative().optional(),
  /** Whether the user confirmed a real connection / booking. */
  confirmed: z.boolean().default(false),
});
export type TransportLeg = z.infer<typeof TransportLegSchema>;

export const TripSchema = EntityBaseSchema.extend({
  name: z.string().min(1).max(200),
  description: z.string().max(10000).optional(),
  region: z.string().max(200).optional(),
  startDate: IsoDateSchema.optional(),
  endDate: IsoDateSchema.optional(),
  activityType: ActivityTypeSchema.default('hiking'),
  status: TripStatusSchema.default('planning'),
  participantsCount: z.number().int().min(1).max(100).default(1),
  routeId: IdSchema.nullable().optional(),
  loadoutId: IdSchema.nullable().optional(),
  coverPhotoUri: z.string().optional(),
  budgetPlanned: z.number().nonnegative().optional(),
  currency: CurrencySchema.default('CZK'),
  favorite: z.boolean().default(false),
  isPrivate: z.boolean().default(true),
  settings: TripSettingsSchema.default(TripSettingsSchema.parse({})),
  transport: z.array(TransportLegSchema).default([]),
  /** Server-side sharing id, present when the trip is shared with a group. */
  shareId: z.string().optional(),
  ownerId: z.string().optional(),
  aiSummary: z.string().max(20000).optional(),
});
export type Trip = z.infer<typeof TripSchema>;

export const TripDaySchema = EntityBaseSchema.extend({
  tripId: IdSchema,
  dayIndex: z.number().int().nonnegative(),
  date: IsoDateSchema.optional(),
  startName: z.string().max(200).optional(),
  endName: z.string().max(200).optional(),
  start: LatLonSchema.optional(),
  end: LatLonSchema.optional(),
  /** Range of route geometry indices covered by this day. */
  fromIdx: z.number().int().nonnegative().optional(),
  toIdx: z.number().int().nonnegative().optional(),
  distanceM: z.number().nonnegative().default(0),
  ascentM: z.number().nonnegative().default(0),
  descentM: z.number().nonnegative().default(0),
  movingTimeMin: z.number().nonnegative().default(0),
  totalTimeMin: z.number().nonnegative().default(0),
  campsiteId: IdSchema.nullable().optional(),
  highlights: z.array(z.string().max(200)).default([]),
  notes: z.string().max(5000).optional(),
  tasks: z.array(z.object({ text: z.string().max(300), done: z.boolean().default(false) })).default([]),
});
export type TripDay = z.infer<typeof TripDaySchema>;

export const ParticipantRoleSchema = z.enum(['owner', 'editor', 'viewer']);
export type ParticipantRole = z.infer<typeof ParticipantRoleSchema>;

export const TripParticipantSchema = EntityBaseSchema.extend({
  tripId: IdSchema,
  name: z.string().min(1).max(120),
  email: z.string().email().optional(),
  role: ParticipantRoleSchema.default('editor'),
  userId: z.string().optional(),
  color: z.string().default('#2F6B3A'),
  bodyWeightKg: z.number().min(20).max(250).optional(),
});
export type TripParticipant = z.infer<typeof TripParticipantSchema>;

// ---------------------------------------------------------------------------
// GPS activities
// ---------------------------------------------------------------------------

export const GPSActivityStatusSchema = z.enum(['recording', 'paused', 'finished']);
export const GPSActivitySchema = EntityBaseSchema.extend({
  tripId: IdSchema.nullable().optional(),
  routeId: IdSchema.nullable().optional(),
  name: z.string().min(1).max(200),
  activityType: ActivityTypeSchema.default('hiking'),
  status: GPSActivityStatusSchema,
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.nullable().optional(),
  distanceM: z.number().nonnegative().default(0),
  movingTimeS: z.number().nonnegative().default(0),
  elapsedTimeS: z.number().nonnegative().default(0),
  ascentM: z.number().nonnegative().default(0),
  descentM: z.number().nonnegative().default(0),
  maxSpeedMs: z.number().nonnegative().default(0),
  pointCount: z.number().int().nonnegative().default(0),
});
export type GPSActivity = z.infer<typeof GPSActivitySchema>;

// ---------------------------------------------------------------------------
// Gear
// ---------------------------------------------------------------------------

export const GearCategoryKeySchema = z.enum([
  'packs',
  'tents',
  'tarps',
  'hammocks',
  'sleeping_bags',
  'quilts',
  'sleeping_pads',
  'clothing',
  'footwear',
  'cooking',
  'water',
  'electronics',
  'hygiene',
  'first_aid',
  'repair',
  'food',
  'other',
]);
export type GearCategoryKey = z.infer<typeof GearCategoryKeySchema>;

export const GearCategorySchema = EntityBaseSchema.extend({
  key: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  icon: z.string().default('package'),
  color: z.string().default('#6B7F5E'),
  builtin: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});
export type GearCategory = z.infer<typeof GearCategorySchema>;

export const WeightSourceSchema = z.enum(['measured', 'manufacturer', 'estimate', 'ai_estimate']);
export type WeightSource = z.infer<typeof WeightSourceSchema>;

export const GearConditionSchema = z.enum(['new', 'good', 'worn', 'needs_repair', 'retired']);

export const GearItemSchema = EntityBaseSchema.extend({
  name: z.string().min(1).max(200),
  brand: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  categoryKey: z.string().min(1).max(60),
  /** Weight of ONE piece in grams. */
  weightG: z.number().nonnegative().max(100000),
  weightSource: WeightSourceSchema.default('measured'),
  /** User confirmed the weight (AI / estimate values start unconfirmed). */
  weightConfirmed: z.boolean().default(true),
  quantity: z.number().int().min(1).max(999).default(1),
  dimensionsCm: z
    .object({ l: z.number().nonnegative(), w: z.number().nonnegative(), h: z.number().nonnegative() })
    .optional(),
  /** Packed volume in liters (one piece). */
  volumeL: z.number().nonnegative().max(500).optional(),
  volumeEstimated: z.boolean().default(false),
  compressible: z.boolean().default(false),
  price: z.number().nonnegative().optional(),
  currency: CurrencySchema.default('CZK'),
  purchaseDate: IsoDateSchema.optional(),
  condition: GearConditionSchema.default('good'),
  photoUri: z.string().optional(),
  description: z.string().max(5000).optional(),
  specs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  notes: z.string().max(5000).optional(),
  url: z.string().url().optional(),
  maintenanceDue: IsoDateSchema.optional(),
  usageCount: z.number().int().nonnegative().default(0),
  tags: z.array(z.string().max(40)).default([]),
  favorite: z.boolean().default(false),
  /** Sleeping bags / quilts: comfort and limit temperatures (EN/ISO 23537). */
  comfortTempC: z.number().min(-60).max(30).optional(),
  limitTempC: z.number().min(-60).max(30).optional(),
  /** Sleeping pads: ASTM F3340 R-value. */
  rValue: z.number().min(0).max(12).optional(),
  /** Electronics: battery capacity. */
  batteryMah: z.number().positive().optional(),
  batteryWh: z.number().positive().optional(),
  waterproof: z.boolean().optional(),
  /** Safety-critical items cannot be removed by the optimizer. */
  essential: z.boolean().default(false),
  barcode: z.string().max(64).optional(),
});
export type GearItem = z.infer<typeof GearItemSchema>;

export const CarryModeSchema = z.enum(['packed', 'worn', 'consumable', 'optional']);
export type CarryMode = z.infer<typeof CarryModeSchema>;

export const PackLocationSchema = z.enum([
  'bottom',
  'middle_back',
  'middle_front',
  'top',
  'lid',
  'hip_belt',
  'side_pocket',
  'front_pocket',
  'shoulder_strap',
  'outside',
  'worn',
]);
export type PackLocation = z.infer<typeof PackLocationSchema>;

export const GearLoadoutSchema = EntityBaseSchema.extend({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  activityType: ActivityTypeSchema.optional(),
  season: z.enum(['spring', 'summer', 'autumn', 'winter', 'all']).default('all'),
  isTemplate: z.boolean().default(false),
  favorite: z.boolean().default(false),
  targetBaseWeightG: z.number().int().positive().optional(),
  packVolumeL: z.number().positive().max(200).optional(),
});
export type GearLoadout = z.infer<typeof GearLoadoutSchema>;

export const LoadoutItemSchema = EntityBaseSchema.extend({
  loadoutId: IdSchema,
  gearItemId: IdSchema,
  quantity: z.number().int().min(1).max(999).default(1),
  carryMode: CarryModeSchema.default('packed'),
  packed: z.boolean().default(false),
  packLocation: PackLocationSchema.optional(),
  container: z.string().max(80).optional(),
  notes: z.string().max(1000).optional(),
  /** Group trips: participant carrying this item. */
  carriedBy: IdSchema.nullable().optional(),
});
export type LoadoutItem = z.infer<typeof LoadoutItemSchema>;

// ---------------------------------------------------------------------------
// Food
// ---------------------------------------------------------------------------

export const MealTypeSchema = z.enum(['breakfast', 'snack', 'lunch', 'dinner', 'drink', 'reserve']);
export type MealType = z.infer<typeof MealTypeSchema>;

export const FoodItemSchema = EntityBaseSchema.extend({
  name: z.string().min(1).max(200),
  brand: z.string().max(120).optional(),
  /** Weight of one package/unit in grams. */
  weightG: z.number().positive().max(20000),
  servings: z.number().positive().max(100).default(1),
  /** Values per whole package/unit. */
  energyKcal: z.number().nonnegative(),
  proteinG: z.number().nonnegative().default(0),
  carbsG: z.number().nonnegative().default(0),
  fatG: z.number().nonnegative().default(0),
  price: z.number().nonnegative().optional(),
  currency: CurrencySchema.default('CZK'),
  shelfLifeDays: z.number().int().nonnegative().optional(),
  /** Water needed to prepare one package/unit (ml). */
  waterMl: z.number().nonnegative().default(0),
  requiresCooking: z.boolean().default(false),
  /** Minutes of boiling/simmering needed (0 = just boil water). */
  cookMinutes: z.number().nonnegative().default(0),
  coldSoakable: z.boolean().default(false),
  allergens: z.array(z.string().max(40)).default([]),
  diet: z.array(z.enum(['vegetarian', 'vegan', 'gluten_free', 'lactose_free'])).default([]),
  mealTypes: z.array(MealTypeSchema).default([]),
  /** 'builtin_typical' = generic typical values, verify with the label. */
  source: z.enum(['user', 'builtin_typical', 'label', 'ai_estimate']).default('user'),
});
export type FoodItem = z.infer<typeof FoodItemSchema>;

export const MealPlanEntrySchema = z.object({
  dayIndex: z.number().int().nonnegative(),
  meal: MealTypeSchema,
  foodItemId: IdSchema,
  quantity: z.number().positive().max(100),
  assignedTo: IdSchema.nullable().optional(),
});
export type MealPlanEntry = z.infer<typeof MealPlanEntrySchema>;

export const MealPlanSchema = EntityBaseSchema.extend({
  tripId: IdSchema.nullable().optional(),
  name: z.string().min(1).max(200),
  days: z.number().int().min(1).max(60),
  people: z.number().int().min(1).max(50),
  targetKcalPerDay: z.number().min(500).max(8000),
  budgetPerDay: z.number().nonnegative().optional(),
  dietRestrictions: z.array(z.string()).default([]),
  entries: z.array(MealPlanEntrySchema).default([]),
});
export type MealPlan = z.infer<typeof MealPlanSchema>;

// ---------------------------------------------------------------------------
// POIs: water and campsites
// ---------------------------------------------------------------------------

export const DataSourceSchema = z.object({
  /** e.g. 'openstreetmap', 'user', 'mapy.com' */
  provider: z.string(),
  /** e.g. 'node/123456' */
  ref: z.string().optional(),
  url: z.string().url().optional(),
  license: z.string().optional(),
  /** When the upstream record was last edited, if known. */
  lastEditedAt: IsoDateTimeSchema.optional(),
  /** When TrailPack retrieved the record. */
  retrievedAt: IsoDateTimeSchema,
});
export type DataSource = z.infer<typeof DataSourceSchema>;

export const WaterSourceTypeSchema = z.enum([
  'spring',
  'drinking_water',
  'well',
  'fountain',
  'water_tap',
  'hut',
  'campsite',
  'stream',
  'other',
]);
export type WaterSourceType = z.infer<typeof WaterSourceTypeSchema>;

export const PotabilitySchema = z.enum(['potable', 'treat', 'not_potable', 'unknown']);
export type Potability = z.infer<typeof PotabilitySchema>;

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const WaterSourceSchema = EntityBaseSchema.extend({
  name: z.string().max(200).optional(),
  type: WaterSourceTypeSchema,
  lat: LatSchema,
  lon: LonSchema,
  eleM: z.number().optional(),
  potability: PotabilitySchema.default('unknown'),
  seasonal: z.boolean().nullable().optional(),
  confidence: ConfidenceSchema.default('low'),
  notes: z.string().max(2000).optional(),
  source: DataSourceSchema,
});
export type WaterSource = z.infer<typeof WaterSourceSchema>;

export const CampsiteTypeSchema = z.enum([
  'campground',
  'bivouac_site',
  'shelter',
  'wilderness_hut',
  'alpine_hut',
  'hostel',
  'hotel',
  'other',
]);
export type CampsiteType = z.infer<typeof CampsiteTypeSchema>;

export const LegalStatusSchema = z.enum(['verified_allowed', 'conditional', 'prohibited', 'unverified']);
export type LegalStatus = z.infer<typeof LegalStatusSchema>;

export const CampsiteSchema = EntityBaseSchema.extend({
  name: z.string().max(200).optional(),
  type: CampsiteTypeSchema,
  lat: LatSchema,
  lon: LonSchema,
  eleM: z.number().optional(),
  water: z.boolean().nullable().optional(),
  toilets: z.boolean().nullable().optional(),
  shelter: z.boolean().nullable().optional(),
  fireplace: z.boolean().nullable().optional(),
  capacity: z.number().int().positive().nullable().optional(),
  fee: z.boolean().nullable().optional(),
  priceText: z.string().max(200).optional(),
  reservation: z.enum(['required', 'recommended', 'no', 'unknown']).default('unknown'),
  website: z.string().url().optional(),
  phone: z.string().max(60).optional(),
  openingHours: z.string().max(200).optional(),
  /** Legal status of overnight stay at this place; official campgrounds/huts are 'verified_allowed'. */
  legalStatus: LegalStatusSchema.default('unverified'),
  legalNote: z.string().max(1000).optional(),
  tents: z.boolean().nullable().optional(),
  source: DataSourceSchema,
});
export type Campsite = z.infer<typeof CampsiteSchema>;

export const FavoritePlaceSchema = EntityBaseSchema.extend({
  name: z.string().min(1).max(200),
  lat: LatSchema,
  lon: LonSchema,
  eleM: z.number().optional(),
  kind: z.string().max(40).default('place'),
  notes: z.string().max(2000).optional(),
  icon: z.string().default('star'),
});
export type FavoritePlace = z.infer<typeof FavoritePlaceSchema>;

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

export const HourlyWeatherSchema = z.object({
  time: z.string(),
  temperatureC: z.number().nullable(),
  apparentTemperatureC: z.number().nullable(),
  humidityPct: z.number().nullable(),
  dewPointC: z.number().nullable(),
  precipitationMm: z.number().nullable(),
  precipitationProbabilityPct: z.number().nullable(),
  windSpeedKmh: z.number().nullable(),
  windGustsKmh: z.number().nullable(),
  windDirectionDeg: z.number().nullable(),
  cloudCoverPct: z.number().nullable(),
  uvIndex: z.number().nullable(),
  weatherCode: z.number().nullable(),
  capeJkg: z.number().nullable().optional(),
  snowDepthM: z.number().nullable().optional(),
  snowfallCm: z.number().nullable().optional(),
  freezingLevelM: z.number().nullable().optional(),
  isDay: z.boolean().nullable().optional(),
});
export type HourlyWeather = z.infer<typeof HourlyWeatherSchema>;

export const DailyWeatherSchema = z.object({
  date: IsoDateSchema,
  tempMinC: z.number().nullable(),
  tempMaxC: z.number().nullable(),
  precipitationSumMm: z.number().nullable(),
  precipitationProbabilityMaxPct: z.number().nullable(),
  windSpeedMaxKmh: z.number().nullable(),
  windGustsMaxKmh: z.number().nullable(),
  uvIndexMax: z.number().nullable(),
  sunrise: z.string().nullable(),
  sunset: z.string().nullable(),
  weatherCode: z.number().nullable(),
});
export type DailyWeather = z.infer<typeof DailyWeatherSchema>;

export const WeatherForecastSchema = z.object({
  lat: LatSchema,
  lon: LonSchema,
  eleM: z.number().nullable().optional(),
  timezone: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  fetchedAt: IsoDateTimeSchema,
  hourly: z.array(HourlyWeatherSchema),
  daily: z.array(DailyWeatherSchema),
  attribution: z.string(),
});
export type WeatherForecast = z.infer<typeof WeatherForecastSchema>;

export const WeatherSnapshotSchema = EntityBaseSchema.extend({
  tripId: IdSchema.nullable().optional(),
  label: z.string().max(200).optional(),
  forecast: WeatherForecastSchema,
});
export type WeatherSnapshot = z.infer<typeof WeatherSnapshotSchema>;

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------

export const DeviceTypeSchema = z.enum([
  'phone',
  'gps',
  'watch',
  'headlamp',
  'camera',
  'action_camera',
  'satellite_messenger',
  'powerbank',
  'other',
]);
export type DeviceType = z.infer<typeof DeviceTypeSchema>;

export const BatteryDeviceSchema = EntityBaseSchema.extend({
  name: z.string().min(1).max(120),
  type: DeviceTypeSchema,
  capacityMah: z.number().positive().max(100000).optional(),
  /** Nominal cell voltage, default Li-ion 3.7 V. */
  nominalVoltage: z.number().positive().max(48).default(3.7),
  capacityWh: z.number().positive().max(1000).optional(),
  /** Average energy consumption when in use, in percent of battery per hour. */
  drainPctPerHour: z.number().nonnegative().max(100).optional(),
  /** Alternative: average draw in watts while in use. */
  drawW: z.number().nonnegative().max(200).optional(),
  /** Standby drain, % per day */
  standbyPctPerDay: z.number().nonnegative().max(100).default(0),
  gearItemId: IdSchema.nullable().optional(),
});
export type BatteryDevice = z.infer<typeof BatteryDeviceSchema>;

export const PowerPlanSchema = EntityBaseSchema.extend({
  tripId: IdSchema.nullable().optional(),
  name: z.string().min(1).max(200),
  days: z.number().int().min(1).max(60),
  devices: z.array(
    z.object({
      deviceId: IdSchema,
      hoursPerDay: z.number().nonnegative().max(24),
      startChargePct: z.number().min(0).max(100).default(100),
      minEndChargePct: z.number().min(0).max(100).default(20),
    }),
  ),
  powerbankIds: z.array(IdSchema).default([]),
  chargingEfficiency: z.number().min(0.3).max(1).default(0.65),
  expectedMinTempC: z.number().min(-50).max(50).default(10),
  outletDays: z.array(z.number().int().nonnegative()).default([]),
});
export type PowerPlan = z.infer<typeof PowerPlanSchema>;

// ---------------------------------------------------------------------------
// Checklists, expenses, journal, photos
// ---------------------------------------------------------------------------

export const ChecklistCategorySchema = z.enum([
  'gear',
  'food',
  'water',
  'electronics',
  'charging',
  'offline_maps',
  'forecast',
  'permits',
  'transport',
  'safety',
  'other',
]);
export type ChecklistCategory = z.infer<typeof ChecklistCategorySchema>;

export const ChecklistSchema = EntityBaseSchema.extend({
  tripId: IdSchema.nullable().optional(),
  name: z.string().min(1).max(200),
  kind: z.enum(['pre_trip', 'packing', 'safety', 'custom']).default('pre_trip'),
});
export type Checklist = z.infer<typeof ChecklistSchema>;

export const ChecklistItemSchema = EntityBaseSchema.extend({
  checklistId: IdSchema,
  text: z.string().min(1).max(500),
  category: ChecklistCategorySchema.default('other'),
  done: z.boolean().default(false),
  doneAt: IsoDateTimeSchema.nullable().optional(),
  assignee: IdSchema.nullable().optional(),
  sortOrder: z.number().int().default(0),
  /** Auto-generated items carry a stable key so regeneration does not duplicate them. */
  autoKey: z.string().max(120).optional(),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const ExpenseCategorySchema = z.enum(['transport', 'food', 'lodging', 'fees', 'fuel', 'gear', 'reserve', 'other']);
export type ExpenseCategory = z.infer<typeof ExpenseCategorySchema>;

export const ExpenseSchema = EntityBaseSchema.extend({
  tripId: IdSchema,
  category: ExpenseCategorySchema,
  description: z.string().max(500).default(''),
  amount: z.number().nonnegative(),
  currency: CurrencySchema,
  /** Rate to convert `currency` to the trip currency, with its date. */
  exchangeRate: z.number().positive().optional(),
  rateDate: IsoDateSchema.optional(),
  rateSource: z.string().max(120).optional(),
  planned: z.boolean().default(false),
  date: IsoDateSchema.optional(),
  paidBy: IdSchema.nullable().optional(),
  splitBetween: z.array(IdSchema).default([]),
});
export type Expense = z.infer<typeof ExpenseSchema>;

export const PhotoEntrySchema = EntityBaseSchema.extend({
  tripId: IdSchema.nullable().optional(),
  uri: z.string().min(1),
  takenAt: IsoDateTimeSchema.optional(),
  lat: LatSchema.optional(),
  lon: LonSchema.optional(),
  caption: z.string().max(1000).optional(),
  shared: z.boolean().default(false),
});
export type PhotoEntry = z.infer<typeof PhotoEntrySchema>;

export const JournalEntrySchema = EntityBaseSchema.extend({
  tripId: IdSchema,
  dayIndex: z.number().int().nonnegative().optional(),
  date: IsoDateSchema.optional(),
  text: z.string().max(20000).default(''),
  rating: z.number().int().min(1).max(5).optional(),
  weatherNote: z.string().max(2000).optional(),
  gearNote: z.string().max(2000).optional(),
  problems: z.string().max(2000).optional(),
  nextTime: z.string().max(2000).optional(),
  lat: LatSchema.optional(),
  lon: LonSchema.optional(),
  photoIds: z.array(IdSchema).default([]),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

export const TripCommentSchema = EntityBaseSchema.extend({
  tripId: IdSchema,
  authorName: z.string().max(120),
  authorId: z.string().optional(),
  text: z.string().min(1).max(5000),
  targetType: z.enum(['trip', 'day', 'checklist_item', 'gear']).default('trip'),
  targetId: z.string().optional(),
});
export type TripComment = z.infer<typeof TripCommentSchema>;

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export const AIConversationSchema = EntityBaseSchema.extend({
  tripId: IdSchema.nullable().optional(),
  title: z.string().max(200).default(''),
  provider: AiProviderIdSchema.optional(),
  model: z.string().optional(),
  totalTokensIn: z.number().int().nonnegative().default(0),
  totalTokensOut: z.number().int().nonnegative().default(0),
  totalCostUsd: z.number().nonnegative().default(0),
});
export type AIConversation = z.infer<typeof AIConversationSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const AIMessageSchema = EntityBaseSchema.extend({
  conversationId: IdSchema,
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.string().max(200000).default(''),
  toolCalls: z.array(ToolCallSchema).default([]),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  isError: z.boolean().default(false),
  attachments: z.array(z.object({ type: z.enum(['image']), uri: z.string(), mimeType: z.string() })).default([]),
  tokensIn: z.number().int().nonnegative().default(0),
  tokensOut: z.number().int().nonnegative().default(0),
});
export type AIMessage = z.infer<typeof AIMessageSchema>;

// ---------------------------------------------------------------------------
// Offline regions
// ---------------------------------------------------------------------------

export const OfflineRegionStatusSchema = z.enum(['pending', 'downloading', 'paused', 'ready', 'error', 'outdated']);
export const OfflineRegionSchema = EntityBaseSchema.extend({
  name: z.string().min(1).max(200),
  bbox: BBoxSchema,
  minZoom: z.number().int().min(0).max(22),
  maxZoom: z.number().int().min(0).max(22),
  styleId: z.string(),
  status: OfflineRegionStatusSchema.default('pending'),
  tileCount: z.number().int().nonnegative().default(0),
  downloadedTiles: z.number().int().nonnegative().default(0),
  sizeBytes: z.number().nonnegative().default(0),
  estimatedSizeBytes: z.number().nonnegative().default(0),
  includesPois: z.boolean().default(true),
  /** Tiles alone never enable offline routing. */
  includesRoutingGraph: z.boolean().default(false),
  tripId: IdSchema.nullable().optional(),
  error: z.string().optional(),
  downloadedAt: IsoDateTimeSchema.nullable().optional(),
});
export type OfflineRegion = z.infer<typeof OfflineRegionSchema>;

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export const ExchangeRateSchema = z.object({
  base: CurrencySchema,
  quote: CurrencySchema,
  rate: z.number().positive(),
  date: IsoDateSchema,
  source: z.string(),
});
export type ExchangeRate = z.infer<typeof ExchangeRateSchema>;

export const SearchHistoryEntrySchema = z.object({
  id: IdSchema,
  query: z.string().max(300),
  label: z.string().max(300).optional(),
  lat: LatSchema.optional(),
  lon: LonSchema.optional(),
  createdAt: IsoDateTimeSchema,
});
export type SearchHistoryEntry = z.infer<typeof SearchHistoryEntrySchema>;

/**
 * Machine-readable advisory produced by deterministic engines. UI translates
 * `code` via i18n; `message` is a Czech fallback for logs / AI context.
 */
export const AdvisorySchema = z.object({
  code: z.string(),
  severity: SeveritySchema,
  message: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  /** Data the advisory is based on (for transparency). */
  basis: z.array(z.string()).default([]),
  /** How to act on it. */
  action: z.string().optional(),
  /** Uncertainty description. */
  uncertainty: z.string().optional(),
  source: z.string().optional(),
  updatedAt: IsoDateTimeSchema.optional(),
});
export type Advisory = z.infer<typeof AdvisorySchema>;

/** Names of all synced tables, used by database + sync layers. */
export const SYNCED_ENTITIES = [
  'trips',
  'trip_days',
  'routes',
  'gps_activities',
  'gear_categories',
  'gear_items',
  'gear_loadouts',
  'loadout_items',
  'food_items',
  'meal_plans',
  'water_sources',
  'campsites',
  'favorite_places',
  'weather_snapshots',
  'battery_devices',
  'power_plans',
  'checklists',
  'checklist_items',
  'expenses',
  'trip_participants',
  'photo_entries',
  'journal_entries',
  'trip_comments',
  'ai_conversations',
  'ai_messages',
  'offline_regions',
  'user_profile',
] as const;
export type SyncedEntity = (typeof SYNCED_ENTITIES)[number];
