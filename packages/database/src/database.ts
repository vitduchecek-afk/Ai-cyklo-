/**
 * TrailPack database facade: typed repositories for every synced entity plus
 * settings, cache, GPS points, sync bookkeeping, backup and diagnostics.
 */
import { z } from 'zod';
import {
  AppSettingsSchema,
  IsoDateTimeSchema,
  SYNCED_ENTITIES,
  TrackPointSchema,
  TrailPackError,
  uuid,
  type AppSettings,
  type EntityBase,
  type GearCategory,
  type KeyValueCache,
  type Route,
  type SyncedEntity,
} from '@trailpack/shared';
import type { SqlDriver } from './driver';
import { currentVersion, migrate } from './migrations';
import { EntityRepository, type ListOptions, type OrderBy, type RepositoryContext } from './repository';
import { ENTITY_SCHEMAS } from './schema';
import {
  ConflictStore,
  ExchangeRateStore,
  GpsPointStore,
  OutboxStore,
  OutboxTracker,
  PersistentCache,
  SearchHistoryStore,
  SettingsStore,
  SyncStateStore,
} from './stores';

export interface CreateDatabaseOptions {
  /** Identifies this installation in the outbox / sync protocol. */
  deviceId: string;
  /** Queue local writes for synchronisation (default false; toggle with `setTrackChanges`). */
  trackChanges?: boolean;
  /** Millisecond clock (injectable for tests). */
  clock?: () => number;
  /** Id generator (injectable for tests). */
  newId?: () => string;
}

type FinderSpec = Record<string, { field: string; orderBy?: OrderBy }>;
type Finders<T extends EntityBase, F extends FinderSpec> = {
  [K in keyof F]: (value: string, opts?: Omit<ListOptions, 'where'>) => Promise<T[]>;
};

/** Add `byX(value)` finder methods to a repository. */
function withFinders<T extends EntityBase, I extends object, F extends FinderSpec>(repo: EntityRepository<T, I>, spec: F): EntityRepository<T, I> & Finders<T, F> {
  const finders: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(spec)) {
    finders[name] = (value: string, opts: Omit<ListOptions, 'where'> = {}) =>
      repo.list({ orderBy: def.orderBy, ...opts, where: { [def.field]: value } });
  }
  return Object.assign(repo, finders) as EntityRepository<T, I> & Finders<T, F>;
}

const BY_TRIP = { byTrip: { field: 'tripId' } } as const;

type SchemaOf<K extends SyncedEntity> = (typeof ENTITY_SCHEMAS)[K];
type Repo<K extends SyncedEntity> = EntityRepository<z.output<SchemaOf<K>> & EntityBase, z.input<SchemaOf<K>> & object>;

/** Build all entity repositories on top of a driver (or transaction handle). */
function buildRepos(driver: SqlDriver, ctx: RepositoryContext) {
  const make = <K extends SyncedEntity>(table: K) => new EntityRepository<EntityBase, object>(driver, table, ENTITY_SCHEMAS[table] as unknown as z.ZodType<EntityBase, object>, ctx) as unknown as Repo<K>;
  const userProfile = make('user_profile');
  return {
    trips: withFinders(make('trips'), { byStatus: { field: 'status', orderBy: { field: 'startDate' } } }),
    tripDays: withFinders(make('trip_days'), { byTrip: { field: 'tripId', orderBy: { field: 'dayIndex' } } }),
    routes: withFinders(make('routes'), BY_TRIP),
    gpsActivities: withFinders(make('gps_activities'), { ...BY_TRIP, byStatus: { field: 'status' } }),
    gearCategories: withFinders(make('gear_categories'), { byKey: { field: 'key' } }),
    gearItems: withFinders(make('gear_items'), { byCategory: { field: 'categoryKey', orderBy: { field: 'createdAt' } } }),
    gearLoadouts: make('gear_loadouts'),
    loadoutItems: withFinders(make('loadout_items'), { byLoadout: { field: 'loadoutId' }, byGearItem: { field: 'gearItemId' } }),
    foodItems: make('food_items'),
    mealPlans: withFinders(make('meal_plans'), BY_TRIP),
    waterSources: make('water_sources'),
    campsites: make('campsites'),
    favoritePlaces: make('favorite_places'),
    weatherSnapshots: withFinders(make('weather_snapshots'), BY_TRIP),
    batteryDevices: withFinders(make('battery_devices'), { byGearItem: { field: 'gearItemId' } }),
    powerPlans: withFinders(make('power_plans'), BY_TRIP),
    checklists: withFinders(make('checklists'), BY_TRIP),
    checklistItems: withFinders(make('checklist_items'), { byChecklist: { field: 'checklistId', orderBy: { field: 'sortOrder' } } }),
    expenses: withFinders(make('expenses'), BY_TRIP),
    tripParticipants: withFinders(make('trip_participants'), BY_TRIP),
    photoEntries: withFinders(make('photo_entries'), BY_TRIP),
    journalEntries: withFinders(make('journal_entries'), BY_TRIP),
    tripComments: withFinders(make('trip_comments'), BY_TRIP),
    aiConversations: withFinders(make('ai_conversations'), BY_TRIP),
    aiMessages: withFinders(make('ai_messages'), { byConversation: { field: 'conversationId' } }),
    offlineRegions: withFinders(make('offline_regions'), { ...BY_TRIP, byStatus: { field: 'status' } }),
    userProfile: Object.assign(userProfile, {
      /** The (single) profile of this installation. */
      current: async () => (await userProfile.list({ limit: 1 }))[0],
    }),
  };
}

export type EntityRepositories = ReturnType<typeof buildRepos>;

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/** Maximum number of entity rows accepted by `importAll`. */
export const MAX_BACKUP_ROWS = 500_000;
/** Maximum number of GPS points accepted by `importAll`. */
export const MAX_BACKUP_GPS_POINTS = 5_000_000;

export const BackupFileSchema = z.object({
  format: z.literal('trailpack-backup'),
  version: z.literal(1),
  exportedAt: IsoDateTimeSchema,
  schemaVersion: z.number().int().min(1),
  entities: z.partialRecord(z.enum(SYNCED_ENTITIES), z.array(z.unknown())),
  gpsPoints: z.array(z.object({ activityId: z.string().min(1).max(64), points: z.array(TrackPointSchema) })).default([]),
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type BackupFile = z.infer<typeof BackupFileSchema>;

export type ImportMode = 'merge' | 'replace';

export interface ImportResult {
  /** Rows written per entity. */
  entities: Partial<Record<SyncedEntity, number>>;
  gpsPoints: number;
  total: number;
}

export interface DatabaseDiagnostics {
  schemaVersion: number;
  rowCounts: Record<SyncedEntity, number>;
  gpsPoints: number;
  cacheEntries: number;
  outboxPending: number;
  conflicts: number;
}

export type TrailPackDatabase = EntityRepositories & {
  readonly driver: SqlDriver;
  readonly deviceId: string;
  /** Apply migrations; returns the schema version. */
  migrate(): Promise<number>;
  /** Whether local writes are queued for sync. */
  readonly trackChanges: boolean;
  setTrackChanges(enabled: boolean): void;
  /** Repository by table name (used by the sync engine and backups). */
  repo(entity: SyncedEntity): EntityRepository<EntityBase>;
  /** Run `fn` atomically against a database bound to a transaction. */
  transaction<T>(fn: (db: TrailPackDatabase) => Promise<T>): Promise<T>;
  settings: { get(): Promise<AppSettings>; set(patch: Partial<AppSettings>): Promise<AppSettings> };
  cache: KeyValueCache & { prune: PersistentCache['prune'] };
  gpsPoints: GpsPointStore;
  searchHistory: SearchHistoryStore;
  exchangeRates: ExchangeRateStore;
  outbox: OutboxStore & { enqueueAll(): Promise<number> };
  syncState: SyncStateStore;
  conflicts: ConflictStore;
  /** Soft-delete a trip together with everything that belongs to it. Returns deleted rows per entity. */
  deleteTripCascade(tripId: string): Promise<Partial<Record<SyncedEntity, number>>>;
  backup: {
    exportAll(): Promise<BackupFile>;
    importAll(file: unknown, mode: ImportMode): Promise<ImportResult>;
  };
  diagnostics(): Promise<DatabaseDiagnostics>;
  /** Remove all user data (keeps the schema). */
  wipeAll(): Promise<void>;
  /** Insert built-in gear categories that are not present yet (deterministic ids, never synced). Returns inserted count. */
  seedGearCategories(
    categories: ReadonlyArray<Pick<GearCategory, 'key' | 'name'> & Partial<Pick<GearCategory, 'icon' | 'color' | 'sortOrder'>>>,
  ): Promise<number>;
};

/**
 * Create the database facade. Call `migrate()` once before using it.
 */
export function createDatabase(driver: SqlDriver, options: CreateDatabaseOptions): TrailPackDatabase {
  const tracker = new OutboxTracker(options.deviceId, options.trackChanges ?? false);
  return buildDatabase(driver, options, tracker);
}

function buildDatabase(driver: SqlDriver, options: CreateDatabaseOptions, tracker: OutboxTracker): TrailPackDatabase {
  const clock = options.clock ?? Date.now;
  const newId = options.newId ?? uuid;
  const now = () => new Date(clock()).toISOString();
  const ctx: RepositoryContext = { now, newId, tracker };
  const repos = buildRepos(driver, ctx);
  const byName = (entity: SyncedEntity): EntityRepository<EntityBase> => new EntityRepository<EntityBase>(driver, entity, ENTITY_SCHEMAS[entity], ctx);

  const settings = new SettingsStore(driver);
  const cache = new PersistentCache(driver, clock);
  const gps = new GpsPointStore(driver);
  const outboxStore = new OutboxStore(driver);
  const conflicts = new ConflictStore(driver, now, newId);

  const db: TrailPackDatabase = {
    ...repos,
    driver,
    deviceId: options.deviceId,
    migrate: () => migrate(driver),
    get trackChanges() {
      return tracker.enabled;
    },
    setTrackChanges(enabled: boolean) {
      tracker.enabled = enabled;
    },
    repo: byName,
    transaction: (fn) => driver.transaction((tx) => fn(buildDatabase(tx, options, tracker))),
    settings,
    cache,
    gpsPoints: gps,
    searchHistory: new SearchHistoryStore(driver, now, newId),
    exchangeRates: new ExchangeRateStore(driver),
    outbox: Object.assign(outboxStore, {
      enqueueAll: () =>
        driver.transaction(async (tx) => {
          let n = 0;
          for (const entity of SYNCED_ENTITIES) {
            const rows = await new EntityRepository<EntityBase>(tx, entity, ENTITY_SCHEMAS[entity], ctx).list({ includeDeleted: true });
            for (const row of rows) {
              await tracker.record(tx, entity, row.deletedAt ? 'delete' : 'upsert', row);
              n++;
            }
          }
          return n;
        }),
    }),
    syncState: new SyncStateStore(driver),
    conflicts,

    async deleteTripCascade(tripId) {
      return driver.transaction(async (tx) => {
        const r = buildRepos(tx, ctx);
        const deleted: Partial<Record<SyncedEntity, number>> = {};
        const del = async (entity: SyncedEntity, rows: readonly EntityBase[]) => {
          const repo = new EntityRepository<EntityBase>(tx, entity, ENTITY_SCHEMAS[entity], ctx);
          let n = 0;
          for (const row of rows) if (await repo.softDelete(row.id)) n++;
          if (n) deleted[entity] = (deleted[entity] ?? 0) + n;
        };
        const trip = await r.trips.get(tripId);
        const checklists = await r.checklists.byTrip(tripId);
        const checklistItems = (await Promise.all(checklists.map((c) => r.checklistItems.byChecklist(c.id)))).flat();
        const routeIds = new Set((await r.routes.byTrip(tripId)).map((x) => x.id));
        if (trip?.routeId) routeIds.add(trip.routeId);
        const routes = (await Promise.all([...routeIds].map((id) => r.routes.get(id)))).filter((x): x is Route => !!x);

        await del('checklist_items', checklistItems);
        await del('checklists', checklists);
        await del('trip_days', await r.tripDays.byTrip(tripId));
        await del('expenses', await r.expenses.byTrip(tripId));
        await del('trip_participants', await r.tripParticipants.byTrip(tripId));
        await del('journal_entries', await r.journalEntries.byTrip(tripId));
        await del('photo_entries', await r.photoEntries.byTrip(tripId));
        await del('trip_comments', await r.tripComments.byTrip(tripId));
        await del('weather_snapshots', await r.weatherSnapshots.byTrip(tripId));
        await del('meal_plans', await r.mealPlans.byTrip(tripId));
        await del('power_plans', await r.powerPlans.byTrip(tripId));
        await del('routes', routes);
        await del('trips', trip ? [trip] : []);
        return deleted;
      });
    },

    backup: {
      async exportAll() {
        return driver.transaction(async (tx) => {
          const entities: Record<string, unknown[]> = {};
          for (const entity of SYNCED_ENTITIES) {
            entities[entity] = await new EntityRepository<EntityBase>(tx, entity, ENTITY_SCHEMAS[entity], ctx).list({ orderBy: { field: 'createdAt' } });
          }
          const g = new GpsPointStore(tx);
          const gpsPoints = [];
          for (const activityId of await g.activityIds()) gpsPoints.push({ activityId, points: await g.read(activityId) });
          return {
            format: 'trailpack-backup' as const,
            version: 1 as const,
            exportedAt: now(),
            schemaVersion: await currentVersion(tx),
            entities,
            gpsPoints,
            settings: await new SettingsStore(tx).raw(),
          };
        });
      },

      async importAll(file, mode) {
        const parsed = BackupFileSchema.safeParse(file);
        if (!parsed.success) {
          throw new TrailPackError('invalid_input', `Invalid backup file: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        }
        const backup = parsed.data;
        const version = await currentVersion(driver);
        if (backup.schemaVersion > version) {
          throw new TrailPackError('unsupported', `Backup was created by a newer app version (schema ${backup.schemaVersion} > ${version})`);
        }
        let rows = 0;
        for (const list of Object.values(backup.entities)) rows += list?.length ?? 0;
        if (rows > MAX_BACKUP_ROWS) throw new TrailPackError('too_large', `Backup contains more than ${MAX_BACKUP_ROWS} rows`);
        const pointCount = backup.gpsPoints.reduce((n, a) => n + a.points.length, 0);
        if (pointCount > MAX_BACKUP_GPS_POINTS) throw new TrailPackError('too_large', `Backup contains more than ${MAX_BACKUP_GPS_POINTS} GPS points`);

        // Validate every row up-front so a bad file never leaves a half-imported database.
        const valid: Partial<Record<SyncedEntity, EntityBase[]>> = {};
        const problems: string[] = [];
        for (const entity of SYNCED_ENTITIES) {
          const list = backup.entities[entity];
          if (!list) continue;
          const out: EntityBase[] = [];
          for (const [i, raw] of list.entries()) {
            const r = ENTITY_SCHEMAS[entity].safeParse(raw);
            if (r.success) out.push(r.data);
            else if (problems.length < 10) problems.push(`${entity}[${i}]: ${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`);
          }
          valid[entity] = out;
        }
        if (problems.length) throw new TrailPackError('invalid_input', `Invalid backup rows: ${problems.join('; ')}`, { details: problems });

        return driver.transaction(async (tx) => {
          const result: ImportResult = { entities: {}, gpsPoints: 0, total: 0 };
          const g = new GpsPointStore(tx);
          if (mode === 'replace') {
            for (const entity of SYNCED_ENTITIES) {
              const repo = new EntityRepository<EntityBase>(tx, entity, ENTITY_SCHEMAS[entity], ctx);
              const keep = new Set((valid[entity] ?? []).map((r) => r.id));
              for (const { id } of await tx.all<{ id: string }>(`SELECT id FROM ${entity}`)) if (!keep.has(id)) await repo.hardDelete(id);
            }
            await tx.run('DELETE FROM gps_points');
            await new SettingsStore(tx).reset();
          }
          for (const entity of SYNCED_ENTITIES) {
            const repo = new EntityRepository<EntityBase>(tx, entity, ENTITY_SCHEMAS[entity], ctx);
            let n = 0;
            for (const row of valid[entity] ?? []) {
              if (mode === 'merge') {
                const existing = await repo.get(row.id, { includeDeleted: true });
                if (existing && Date.parse(existing.updatedAt) >= Date.parse(row.updatedAt)) continue;
              }
              await repo.upsert(row);
              n++;
            }
            if (n) result.entities[entity] = n;
            result.total += n;
          }
          for (const a of backup.gpsPoints) {
            if (mode === 'merge' && (await g.count(a.activityId)) > 0) continue;
            for (let i = 0; i < a.points.length; i += 10_000) {
              result.gpsPoints += await g.appendBatch(a.activityId, a.points.slice(i, i + 10_000));
            }
          }
          const st = new SettingsStore(tx);
          if (mode === 'replace' || Object.keys(await st.raw()).length === 0) {
            if (Object.keys(backup.settings).length) await applyBackupSettings(st, backup.settings);
          }
          return result;
        });
      },
    },

    async diagnostics() {
      const rowCounts = {} as Record<SyncedEntity, number>;
      for (const entity of SYNCED_ENTITIES) {
        rowCounts[entity] = (await driver.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${entity} WHERE deleted_at IS NULL`))?.n ?? 0;
      }
      return {
        schemaVersion: await currentVersion(driver),
        rowCounts,
        gpsPoints: await gps.total(),
        cacheEntries: await cache.size(),
        outboxPending: await outboxStore.count(),
        conflicts: await conflicts.countOpen(),
      };
    },

    async wipeAll() {
      await driver.transaction(async (tx) => {
        for (const t of [...SYNCED_ENTITIES, 'settings', 'kv_cache', 'sync_outbox', 'sync_state', 'sync_conflicts', 'gps_points', 'search_history', 'exchange_rates']) {
          await tx.run(`DELETE FROM ${t}`);
        }
      });
    },

    async seedGearCategories(categories) {
      return driver.transaction(async (tx) => {
        const repo = buildRepos(tx, ctx).gearCategories;
        let inserted = 0;
        for (const [i, c] of categories.entries()) {
          const id = `cat_${c.key}`;
          if (await repo.get(id, { includeDeleted: true })) continue;
          if ((await repo.byKey(c.key)).length > 0) continue;
          const t = now();
          await repo.upsert(
            {
              id,
              createdAt: t,
              updatedAt: t,
              deletedAt: null,
              key: c.key,
              name: c.name,
              icon: c.icon ?? 'package',
              color: c.color ?? '#6B7F5E',
              builtin: true,
              sortOrder: c.sortOrder ?? i,
            },
            { fromSync: true },
          );
          inserted++;
        }
        return inserted;
      });
    },
  };
  return db;
}

/** Apply stored settings from a backup, ignoring keys that no longer validate. */
async function applyBackupSettings(store: SettingsStore, settings: Record<string, unknown>): Promise<AppSettings> {
  try {
    return await store.set(settings as Partial<AppSettings>);
  } catch {
    const shape = AppSettingsSchema.shape as Record<string, z.ZodType>;
    const ok: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(settings)) if (shape[k]?.safeParse(v).success) ok[k] = v;
    return store.set(ok as Partial<AppSettings>);
  }
}
