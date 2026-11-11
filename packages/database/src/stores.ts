/**
 * Auxiliary stores that live next to the synced entity tables: settings,
 * persistent cache, GPS points, search history, exchange rates and the sync
 * bookkeeping tables (outbox, state, conflicts).
 */
import {
  AppSettingsSchema,
  DEFAULT_SETTINGS,
  ExchangeRateSchema,
  TrackPointSchema,
  TrailPackError,
  type AppSettings,
  type CacheEntry,
  type EntityBase,
  type ExchangeRate,
  type KeyValueCache,
  type SearchHistoryEntry,
  type SyncedEntity,
  type TrackPoint,
} from '@trailpack/shared';
import { z } from 'zod';
import type { SqlDriver, SqlValue } from './driver';
import type { ChangeTracker, OutboxOp } from './repository';
import { escapeLike } from './repository';

/** Largest number of SQL parameters used in a single statement. */
const CHUNK = 400;

function chunks<T>(xs: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export class SettingsStore {
  constructor(private readonly driver: SqlDriver) {}

  /** Current settings: stored values merged over the defaults; invalid stored keys fall back to defaults. */
  async get(): Promise<AppSettings> {
    const row = await this.driver.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', ['app']);
    if (!row) return { ...DEFAULT_SETTINGS };
    let stored: unknown;
    try {
      stored = JSON.parse(row.value);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { ...DEFAULT_SETTINGS };
    const whole = AppSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...stored });
    if (whole.success) return whole.data;
    // Salvage every individually valid key.
    const shape = AppSettingsSchema.shape as Record<string, z.ZodType>;
    const salvaged: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
      const field = shape[k];
      if (field && field.safeParse(v).success) salvaged[k] = v;
    }
    return AppSettingsSchema.parse({ ...DEFAULT_SETTINGS, ...salvaged });
  }

  /** Merge `patch` into the stored settings (validated) and return the result. */
  async set(patch: Partial<AppSettings>): Promise<AppSettings> {
    return this.driver.transaction(async (tx) => {
      const current = await new SettingsStore(tx).get();
      const parsed = AppSettingsSchema.safeParse({ ...current, ...patch });
      if (!parsed.success) {
        throw new TrailPackError('invalid_input', `Invalid settings: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, {
          details: parsed.error.issues,
        });
      }
      await tx.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
        'app',
        JSON.stringify(parsed.data),
      ]);
      return parsed.data;
    });
  }

  /** Raw stored object (used by backups). */
  async raw(): Promise<Record<string, unknown>> {
    const row = await this.driver.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', ['app']);
    if (!row) return {};
    try {
      const v = JSON.parse(row.value);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  async reset(): Promise<void> {
    await this.driver.run('DELETE FROM settings');
  }
}

// ---------------------------------------------------------------------------
// Persistent cache
// ---------------------------------------------------------------------------

export interface PruneOptions {
  /** Keep expired entries this long (stale-if-error window). Default 7 days. */
  staleGraceMs?: number;
  /** Keep at most this many entries (oldest are evicted first). Default 2000. */
  maxEntries?: number;
}

/** `KeyValueCache` persisted in SQLite so provider data survives restarts and stays usable offline. */
export class PersistentCache implements KeyValueCache {
  constructor(
    private readonly driver: SqlDriver,
    private readonly nowMs: () => number,
  ) {}

  /** Returns the entry even when expired – callers decide via `expiresAt` (stale-if-error). */
  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const row = await this.driver.get<{ value: string; stored_at: number; expires_at: number }>(
      'SELECT value, stored_at, expires_at FROM kv_cache WHERE key = ?',
      [key],
    );
    if (!row) return undefined;
    try {
      return { value: JSON.parse(row.value) as T, storedAt: row.stored_at, expiresAt: row.expires_at };
    } catch {
      await this.delete(key);
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const now = this.nowMs();
    await this.driver.run(
      `INSERT INTO kv_cache (key, value, stored_at, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, stored_at = excluded.stored_at, expires_at = excluded.expires_at`,
      [key, JSON.stringify(value ?? null), now, now + Math.max(0, ttlMs)],
    );
  }

  async delete(key: string): Promise<void> {
    await this.driver.run('DELETE FROM kv_cache WHERE key = ?', [key]);
  }

  async clear(prefix?: string): Promise<void> {
    if (!prefix) await this.driver.run('DELETE FROM kv_cache');
    else await this.driver.run(`DELETE FROM kv_cache WHERE key LIKE ? ESCAPE '\\'`, [`${escapeLike(prefix)}%`]);
  }

  async size(): Promise<number> {
    return (await this.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM kv_cache'))?.n ?? 0;
  }

  /** Drop long-expired entries and enforce the entry limit. Returns the number of removed rows. */
  async prune(opts: PruneOptions = {}): Promise<number> {
    const grace = opts.staleGraceMs ?? 7 * 24 * 3600 * 1000;
    const max = opts.maxEntries ?? 2000;
    return this.driver.transaction(async (tx) => {
      let removed = (await tx.run('DELETE FROM kv_cache WHERE expires_at < ?', [this.nowMs() - grace])).changes;
      const n = (await tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM kv_cache'))?.n ?? 0;
      if (n > max) {
        removed += (
          await tx.run(
            'DELETE FROM kv_cache WHERE key IN (SELECT key FROM kv_cache ORDER BY stored_at ASC, key ASC LIMIT ?)',
            [n - max],
          )
        ).changes;
      }
      return removed;
    });
  }
}

// ---------------------------------------------------------------------------
// GPS points
// ---------------------------------------------------------------------------

const MAX_POINTS_PER_BATCH = 20000;

export class GpsPointStore {
  constructor(private readonly driver: SqlDriver) {}

  /** Append points to an activity; sequence numbers continue where the last batch ended. Returns the number of appended points. */
  async appendBatch(activityId: string, points: readonly TrackPoint[]): Promise<number> {
    if (points.length === 0) return 0;
    if (points.length > MAX_POINTS_PER_BATCH) {
      throw new TrailPackError('too_large', `At most ${MAX_POINTS_PER_BATCH} GPS points per batch`);
    }
    const valid = z.array(TrackPointSchema).parse(points);
    return this.driver.transaction(async (tx) => {
      const last = await tx.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM gps_points WHERE activity_id = ?', [activityId]);
      let seq = (last?.m ?? -1) + 1;
      for (const p of valid) {
        await tx.run(
          'INSERT INTO gps_points (activity_id, seq, lat, lon, ele, time, accuracy, speed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [activityId, seq++, p.lat, p.lon, p.ele ?? null, p.time ?? null, p.accuracy ?? null, p.speed ?? null],
        );
      }
      return valid.length;
    });
  }

  /** Read points in recording order. `from` is a zero based point index. */
  async read(activityId: string, opts: { from?: number; limit?: number } = {}): Promise<TrackPoint[]> {
    const rows = await this.driver.all<{
      lat: number;
      lon: number;
      ele: number | null;
      time: number | null;
      accuracy: number | null;
      speed: number | null;
    }>(
      'SELECT lat, lon, ele, time, accuracy, speed FROM gps_points WHERE activity_id = ? AND seq >= ? ORDER BY seq ASC LIMIT ?',
      [activityId, Math.max(0, opts.from ?? 0), opts.limit ?? 100000],
    );
    return rows.map((r) => {
      const p: TrackPoint = { lat: r.lat, lon: r.lon };
      if (r.ele !== null) p.ele = r.ele;
      if (r.time !== null) p.time = r.time;
      if (r.accuracy !== null) p.accuracy = r.accuracy;
      if (r.speed !== null) p.speed = r.speed;
      return p;
    });
  }

  async count(activityId: string): Promise<number> {
    return (await this.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM gps_points WHERE activity_id = ?', [activityId]))?.n ?? 0;
  }

  async deleteForActivity(activityId: string): Promise<number> {
    return (await this.driver.run('DELETE FROM gps_points WHERE activity_id = ?', [activityId])).changes;
  }

  /** Ids of all activities that have recorded points. */
  async activityIds(): Promise<string[]> {
    const rows = await this.driver.all<{ activity_id: string }>('SELECT DISTINCT activity_id FROM gps_points ORDER BY activity_id');
    return rows.map((r) => r.activity_id);
  }

  async total(): Promise<number> {
    return (await this.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM gps_points'))?.n ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Search history
// ---------------------------------------------------------------------------

const MAX_SEARCH_HISTORY = 50;

export class SearchHistoryStore {
  constructor(
    private readonly driver: SqlDriver,
    private readonly now: () => string,
    private readonly newId: () => string,
  ) {}

  /** Remember a search; an identical earlier query is replaced and the list is capped at 50 entries. */
  async add(entry: { query: string; label?: string; lat?: number; lon?: number }): Promise<SearchHistoryEntry> {
    const query = entry.query.trim();
    if (!query) throw new TrailPackError('invalid_input', 'Empty search query');
    const created: SearchHistoryEntry = { id: this.newId(), query: query.slice(0, 300), createdAt: this.now() };
    if (entry.label !== undefined) created.label = entry.label.slice(0, 300);
    if (entry.lat !== undefined) created.lat = entry.lat;
    if (entry.lon !== undefined) created.lon = entry.lon;
    await this.driver.transaction(async (tx) => {
      await tx.run('DELETE FROM search_history WHERE query = ?', [created.query]);
      await tx.run('INSERT INTO search_history (id, query, label, lat, lon, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        created.id,
        created.query,
        created.label ?? null,
        created.lat ?? null,
        created.lon ?? null,
        created.createdAt,
      ]);
      await tx.run(
        'DELETE FROM search_history WHERE id NOT IN (SELECT id FROM search_history ORDER BY created_at DESC, id DESC LIMIT ?)',
        [MAX_SEARCH_HISTORY],
      );
    });
    return created;
  }

  async list(limit = 20): Promise<SearchHistoryEntry[]> {
    const rows = await this.driver.all<{
      id: string;
      query: string;
      label: string | null;
      lat: number | null;
      lon: number | null;
      created_at: string;
    }>('SELECT * FROM search_history ORDER BY created_at DESC, id DESC LIMIT ?', [limit]);
    return rows.map((r) => {
      const e: SearchHistoryEntry = { id: r.id, query: r.query, createdAt: r.created_at };
      if (r.label !== null) e.label = r.label;
      if (r.lat !== null) e.lat = r.lat;
      if (r.lon !== null) e.lon = r.lon;
      return e;
    });
  }

  async clear(): Promise<void> {
    await this.driver.run('DELETE FROM search_history');
  }
}

// ---------------------------------------------------------------------------
// Exchange rates
// ---------------------------------------------------------------------------

export class ExchangeRateStore {
  constructor(private readonly driver: SqlDriver) {}

  async set(rate: ExchangeRate): Promise<void> {
    const r = ExchangeRateSchema.parse(rate);
    await this.driver.run(
      `INSERT INTO exchange_rates (base, quote, date, rate, source) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(base, quote, date) DO UPDATE SET rate = excluded.rate, source = excluded.source`,
      [r.base, r.quote, r.date, r.rate, r.source],
    );
  }

  /** Rate for `date` or, when omitted, the most recent one. With a date the latest rate on or before it is used. */
  async get(base: string, quote: string, date?: string): Promise<ExchangeRate | undefined> {
    const row = await this.driver.get<ExchangeRate>(
      date
        ? 'SELECT base, quote, date, rate, source FROM exchange_rates WHERE base = ? AND quote = ? AND date <= ? ORDER BY date DESC LIMIT 1'
        : 'SELECT base, quote, date, rate, source FROM exchange_rates WHERE base = ? AND quote = ? ORDER BY date DESC LIMIT 1',
      date ? [base, quote, date] : [base, quote],
    );
    return row;
  }
}

// ---------------------------------------------------------------------------
// Sync bookkeeping
// ---------------------------------------------------------------------------

export interface OutboxEntry {
  seq: number;
  entity: SyncedEntity;
  entityId: string;
  op: OutboxOp;
  /** Full entity document (tombstone for deletes). */
  payload: Record<string, unknown> | null;
  updatedAt: string;
  deviceId: string;
}

interface OutboxRow {
  seq: number;
  entity: SyncedEntity;
  entity_id: string;
  op: OutboxOp;
  payload: string | null;
  updated_at: string;
  device_id: string;
}

const toEntry = (r: OutboxRow): OutboxEntry => ({
  seq: r.seq,
  entity: r.entity,
  entityId: r.entity_id,
  op: r.op,
  payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : null,
  updatedAt: r.updated_at,
  deviceId: r.device_id,
});

/** Writes local changes to `sync_outbox`; later changes to the same entity replace pending ones. */
export class OutboxTracker implements ChangeTracker {
  enabled: boolean;
  constructor(
    private readonly deviceId: string,
    enabled: boolean,
  ) {
    this.enabled = enabled;
  }

  async record(tx: SqlDriver, entity: SyncedEntity, op: OutboxOp, row: EntityBase): Promise<void> {
    await tx.run('DELETE FROM sync_outbox WHERE entity = ? AND entity_id = ?', [entity, row.id]);
    await tx.run('INSERT INTO sync_outbox (entity, entity_id, op, payload, updated_at, device_id) VALUES (?, ?, ?, ?, ?, ?)', [
      entity,
      row.id,
      op,
      JSON.stringify(row),
      row.updatedAt,
      this.deviceId,
    ]);
  }
}

export class OutboxStore {
  constructor(private readonly driver: SqlDriver) {}

  /** Oldest pending changes first. */
  async pending(limit = 100): Promise<OutboxEntry[]> {
    const rows = await this.driver.all<OutboxRow>('SELECT * FROM sync_outbox ORDER BY seq ASC LIMIT ?', [limit]);
    return rows.map(toEntry);
  }

  /** Pending entries of one entity. */
  async pendingFor(entity: SyncedEntity, entityId: string): Promise<OutboxEntry[]> {
    const rows = await this.driver.all<OutboxRow>('SELECT * FROM sync_outbox WHERE entity = ? AND entity_id = ? ORDER BY seq ASC', [
      entity,
      entityId,
    ]);
    return rows.map(toEntry);
  }

  /** Remove entries that were uploaded. Returns the number of removed rows. */
  async markSent(seqs: readonly number[]): Promise<number> {
    let n = 0;
    for (const part of chunks(seqs)) {
      n += (await this.driver.run(`DELETE FROM sync_outbox WHERE seq IN (${part.map(() => '?').join(', ')})`, part)).changes;
    }
    return n;
  }

  /** Drop pending entries of one entity (its local version lost a conflict). */
  async discardFor(entity: SyncedEntity, entityId: string): Promise<void> {
    await this.driver.run('DELETE FROM sync_outbox WHERE entity = ? AND entity_id = ?', [entity, entityId]);
  }

  async count(): Promise<number> {
    return (await this.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_outbox'))?.n ?? 0;
  }

  async clear(): Promise<void> {
    await this.driver.run('DELETE FROM sync_outbox');
  }
}

export class SyncStateStore {
  constructor(private readonly driver: SqlDriver) {}

  async get(key: string): Promise<string | undefined> {
    return (await this.driver.get<{ value: string }>('SELECT value FROM sync_state WHERE key = ?', [key]))?.value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.driver.run('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  }

  async delete(key: string): Promise<void> {
    await this.driver.run('DELETE FROM sync_state WHERE key = ?', [key]);
  }
}

export interface SyncConflict {
  id: string;
  entity: SyncedEntity;
  entityId: string;
  /** Local version at the time of the conflict. */
  local: Record<string, unknown>;
  /** Remote version at the time of the conflict. */
  remote: Record<string, unknown>;
  resolved: boolean;
  createdAt: string;
}

interface ConflictRow {
  id: string;
  entity: SyncedEntity;
  entity_id: string;
  local: string;
  remote: string;
  resolved: number;
  created_at: string;
}

const toConflict = (r: ConflictRow): SyncConflict => ({
  id: r.id,
  entity: r.entity,
  entityId: r.entity_id,
  local: JSON.parse(r.local) as Record<string, unknown>,
  remote: JSON.parse(r.remote) as Record<string, unknown>,
  resolved: r.resolved === 1,
  createdAt: r.created_at,
});

export class ConflictStore {
  constructor(
    private readonly driver: SqlDriver,
    private readonly now: () => string,
    private readonly newId: () => string,
  ) {}

  async add(input: { entity: SyncedEntity; entityId: string; local: Record<string, unknown>; remote: Record<string, unknown> }): Promise<SyncConflict> {
    const c: SyncConflict = { id: this.newId(), ...input, resolved: false, createdAt: this.now() };
    await this.driver.run(
      'INSERT INTO sync_conflicts (id, entity, entity_id, local, remote, resolved, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
      [c.id, c.entity, c.entityId, JSON.stringify(c.local), JSON.stringify(c.remote), c.createdAt],
    );
    return c;
  }

  async get(id: string): Promise<SyncConflict | undefined> {
    const r = await this.driver.get<ConflictRow>('SELECT * FROM sync_conflicts WHERE id = ?', [id]);
    return r ? toConflict(r) : undefined;
  }

  async list(opts: { includeResolved?: boolean } = {}): Promise<SyncConflict[]> {
    const rows = await this.driver.all<ConflictRow>(
      `SELECT * FROM sync_conflicts ${opts.includeResolved ? '' : 'WHERE resolved = 0'} ORDER BY created_at ASC, id ASC`,
    );
    return rows.map(toConflict);
  }

  async resolve(id: string): Promise<boolean> {
    return (await this.driver.run('UPDATE sync_conflicts SET resolved = 1 WHERE id = ? AND resolved = 0', [id])).changes > 0;
  }

  async countOpen(): Promise<number> {
    return (await this.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolved = 0'))?.n ?? 0;
  }
}

export type { SqlValue };
