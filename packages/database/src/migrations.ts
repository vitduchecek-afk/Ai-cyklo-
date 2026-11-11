/**
 * Versioned, transactional, idempotent schema migrations.
 */
import { SYNCED_ENTITIES } from '@trailpack/shared';
import type { SqlDriver } from './driver';
import { INDEXED_COLUMNS } from './schema';

export interface Migration {
  version: number;
  name: string;
  up(tx: SqlDriver): Promise<void>;
}

function entityTableSql(table: (typeof SYNCED_ENTITIES)[number]): string[] {
  const cols = INDEXED_COLUMNS[table];
  const extra = cols.map((c) => `, ${c.column} TEXT`).join('');
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY NOT NULL,
      data TEXT NOT NULL CHECK (json_valid(data)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT${extra}
    )`,
    `CREATE INDEX IF NOT EXISTS idx_${table}_updated ON ${table} (updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_${table}_deleted ON ${table} (deleted_at)`,
  ];
  for (const c of cols) {
    statements.push(`CREATE INDEX IF NOT EXISTS idx_${table}_${c.column} ON ${table} (${c.column})`);
  }
  return statements;
}

const MIGRATION_1: Migration = {
  version: 1,
  name: 'initial schema',
  async up(tx) {
    for (const table of SYNCED_ENTITIES) {
      for (const sql of entityTableSql(table)) await tx.exec(sql);
    }
    const statements = [
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS kv_cache (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        stored_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_kv_cache_expires ON kv_cache (expires_at)`,
      `CREATE TABLE IF NOT EXISTS sync_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
        payload TEXT,
        updated_at TEXT NOT NULL,
        device_id TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity ON sync_outbox (entity, entity_id)`,
      `CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sync_conflicts (
        id TEXT PRIMARY KEY NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        local TEXT NOT NULL,
        remote TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sync_conflicts_resolved ON sync_conflicts (resolved, created_at)`,
      `CREATE TABLE IF NOT EXISTS gps_points (
        activity_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        ele REAL,
        time INTEGER,
        accuracy REAL,
        speed REAL,
        PRIMARY KEY (activity_id, seq)
      )`,
      `CREATE TABLE IF NOT EXISTS search_history (
        id TEXT PRIMARY KEY NOT NULL,
        query TEXT NOT NULL,
        label TEXT,
        lat REAL,
        lon REAL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_search_history_created ON search_history (created_at)`,
      `CREATE TABLE IF NOT EXISTS exchange_rates (
        base TEXT NOT NULL,
        quote TEXT NOT NULL,
        date TEXT NOT NULL,
        rate REAL NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (base, quote, date)
      )`,
    ];
    for (const sql of statements) await tx.exec(sql);
  },
};

/** All migrations in ascending version order. */
export const MIGRATIONS: readonly Migration[] = [MIGRATION_1];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * Apply pending migrations. Safe to call on every start and from several
 * callers; each migration runs in its own transaction.
 * @returns the schema version after migrating
 */
export async function migrate(driver: SqlDriver, migrations: readonly Migration[] = MIGRATIONS): Promise<number> {
  await driver.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`,
  );
  for (const m of migrations) {
    await driver.transaction(async (tx) => {
      const applied = await tx.get('SELECT version FROM schema_migrations WHERE version = ?', [m.version]);
      if (applied) return;
      await m.up(tx);
      await tx.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        m.version,
        m.name,
        new Date().toISOString(),
      ]);
    });
  }
  return currentVersion(driver);
}

/** Highest applied schema version (0 when the database is empty). */
export async function currentVersion(driver: SqlDriver): Promise<number> {
  const row = await driver.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations');
  return row?.v ?? 0;
}
