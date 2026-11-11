/**
 * Static description of the synced entity tables: which zod schema validates
 * them and which JSON fields are mirrored into indexed SQL columns.
 */
import { z } from 'zod';
import {
  AIConversationSchema,
  AIMessageSchema,
  BatteryDeviceSchema,
  CampsiteSchema,
  ChecklistItemSchema,
  ChecklistSchema,
  ExpenseSchema,
  FavoritePlaceSchema,
  FoodItemSchema,
  GearCategorySchema,
  GearItemSchema,
  GearLoadoutSchema,
  GPSActivitySchema,
  JournalEntrySchema,
  LoadoutItemSchema,
  MealPlanSchema,
  OfflineRegionSchema,
  PhotoEntrySchema,
  PowerPlanSchema,
  RouteSchema,
  TripCommentSchema,
  TripDaySchema,
  TripParticipantSchema,
  TripSchema,
  UserProfileSchema,
  WaterSourceSchema,
  WeatherSnapshotSchema,
  type EntityBase,
  type SyncedEntity,
} from '@trailpack/shared';

/** Mirror of one JSON field in an indexed SQL column. */
export interface IndexedColumn {
  /** SQL column name (snake_case). */
  column: string;
  /** Field name inside the entity JSON (camelCase). */
  field: string;
}

const col = (field: string, column?: string): IndexedColumn => ({
  field,
  column: column ?? field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
});

/** Indexed FK / filter columns per table. */
export const INDEXED_COLUMNS: Record<SyncedEntity, readonly IndexedColumn[]> = {
  trips: [col('status'), col('startDate')],
  trip_days: [col('tripId')],
  routes: [col('tripId')],
  gps_activities: [col('tripId'), col('status')],
  gear_categories: [col('key', 'category_key')],
  gear_items: [col('categoryKey')],
  gear_loadouts: [],
  loadout_items: [col('loadoutId'), col('gearItemId')],
  food_items: [],
  meal_plans: [col('tripId')],
  water_sources: [],
  campsites: [],
  favorite_places: [],
  weather_snapshots: [col('tripId')],
  battery_devices: [col('gearItemId')],
  power_plans: [col('tripId')],
  checklists: [col('tripId')],
  checklist_items: [col('checklistId')],
  expenses: [col('tripId')],
  trip_participants: [col('tripId')],
  photo_entries: [col('tripId')],
  journal_entries: [col('tripId')],
  trip_comments: [col('tripId')],
  ai_conversations: [col('tripId')],
  ai_messages: [col('conversationId')],
  offline_regions: [col('tripId'), col('status')],
  user_profile: [],
};

/** Zod schema used to validate each synced entity. */
export const ENTITY_SCHEMAS = {
  trips: TripSchema,
  trip_days: TripDaySchema,
  routes: RouteSchema,
  gps_activities: GPSActivitySchema,
  gear_categories: GearCategorySchema,
  gear_items: GearItemSchema,
  gear_loadouts: GearLoadoutSchema,
  loadout_items: LoadoutItemSchema,
  food_items: FoodItemSchema,
  meal_plans: MealPlanSchema,
  water_sources: WaterSourceSchema,
  campsites: CampsiteSchema,
  favorite_places: FavoritePlaceSchema,
  weather_snapshots: WeatherSnapshotSchema,
  battery_devices: BatteryDeviceSchema,
  power_plans: PowerPlanSchema,
  checklists: ChecklistSchema,
  checklist_items: ChecklistItemSchema,
  expenses: ExpenseSchema,
  trip_participants: TripParticipantSchema,
  photo_entries: PhotoEntrySchema,
  journal_entries: JournalEntrySchema,
  trip_comments: TripCommentSchema,
  ai_conversations: AIConversationSchema,
  ai_messages: AIMessageSchema,
  offline_regions: OfflineRegionSchema,
  user_profile: UserProfileSchema,
} as const satisfies { [K in SyncedEntity]: z.ZodType<EntityBase> };
