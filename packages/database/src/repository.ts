/**
 * Generic repository for synced entities. Every entity is stored as a JSON
 * document (`data`) plus a few mirrored, indexed columns for fast lookups.
 *
 * Writes are validated with the entity's zod schema; reads trust the stored
 * JSON (it was validated on the way in), which keeps list queries cheap on
 * mobile devices.
 */
import type { z } from 'zod';
import { TrailPackError, type EntityBase, type SyncedEntity } from '@trailpack/shared';
import type { SqlDriver, SqlValue } from './driver';
import { INDEXED_COLUMNS, type IndexedColumn } from './schema';

export type OutboxOp = 'upsert' | 'delete';

/** Records local changes so the sync engine can push them later. */
export interface ChangeTracker {
  readonly enabled: boolean;
  record(tx: SqlDriver, entity: SyncedEntity, op: OutboxOp, row: EntityBase): Promise<void>;
}

export interface RepositoryContext {
  /** ISO timestamp provider (injectable for tests). */
  now(): string;
  newId(): string;
  tracker: ChangeTracker;
}

export type WhereValue = string | number | boolean | null | readonly (string | number)[];
/** Filter on entity fields. Unknown fields are matched on the JSON document. */
export type Where = Record<string, WhereValue | undefined>;

export interface OrderBy {
  field: string;
  direction?: 'asc' | 'desc';
}

export interface ListOptions {
  where?: Where;
  /** Include tombstones (default false). */
  includeDeleted?: boolean;
  orderBy?: OrderBy | readonly OrderBy[];
  limit?: number;
  offset?: number;
}

/** Input for `insert`: base fields are optional and filled in. */
export type EntityDraft<I> = Omit<I, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'> & Partial<EntityBase>;

export interface WriteOptions {
  /** The write originates from the sync engine: keep timestamps, skip the outbox. */
  fromSync?: boolean;
}

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BASE_COLUMNS: Record<string, string> = { id: 'id', createdAt: 'created_at', updatedAt: 'updated_at', deletedAt: 'deleted_at' };

interface RawRow {
  data: string;
}

/** Escape `%`, `_` and `\` for a LIKE pattern using `ESCAPE '\'`. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * @typeParam T validated entity type (schema output)
 * @typeParam I accepted draft input type (schema input – fields with defaults are optional)
 */
export class EntityRepository<T extends EntityBase, I = T> {
  private readonly indexed: readonly IndexedColumn[];

  constructor(
    protected readonly driver: SqlDriver,
    readonly table: SyncedEntity,
    readonly schema: z.ZodType<T, I>,
    protected readonly ctx: RepositoryContext,
  ) {
    this.indexed = INDEXED_COLUMNS[table];
  }

  /** Same repository bound to another driver (e.g. a transaction handle). */
  bind(driver: SqlDriver): EntityRepository<T, I> {
    return new EntityRepository<T, I>(driver, this.table, this.schema, this.ctx);
  }

  // ---- reads -------------------------------------------------------------

  /** Fetch one entity. Tombstones are hidden unless `includeDeleted`. */
  async get(id: string, opts: { includeDeleted?: boolean } = {}): Promise<T | undefined> {
    return this.getWith(this.driver, id, opts.includeDeleted ?? false);
  }

  async list(opts: ListOptions = {}): Promise<T[]> {
    const { sql, params } = this.selectSql('data', opts);
    const rows = await this.driver.all<RawRow>(sql, params);
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  async count(where?: Where, includeDeleted = false): Promise<number> {
    const { sql, params } = this.selectSql('COUNT(*) AS n', { where, includeDeleted }, false);
    const row = await this.driver.get<{ n: number }>(sql, params);
    return row?.n ?? 0;
  }

  /** Case-insensitive (ASCII) substring search over the serialised document. */
  async search(text: string, limit = 50): Promise<T[]> {
    const needle = text.trim();
    if (!needle) return [];
    const rows = await this.driver.all<RawRow>(
      `SELECT data FROM ${this.table} WHERE deleted_at IS NULL AND data LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?`,
      [`%${escapeLike(needle)}%`, Math.max(1, Math.min(500, Math.floor(limit)))],
    );
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  // ---- writes ------------------------------------------------------------

  /** Insert a new entity; missing base fields are generated. Fails when the id exists. */
  async insert(input: EntityDraft<I> | T): Promise<T> {
    const now = this.ctx.now();
    const candidate = {
      ...input,
      id: input.id ?? this.ctx.newId(),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      deletedAt: input.deletedAt ?? null,
    };
    const entity = this.validate(candidate);
    return this.driver.transaction(async (tx) => {
      if (await tx.get(`SELECT 1 AS x FROM ${this.table} WHERE id = ?`, [entity.id])) {
        throw new TrailPackError('conflict', `${this.table}/${entity.id} already exists`);
      }
      await this.writeRow(tx, entity);
      await this.track(tx, 'upsert', entity);
      return entity;
    });
  }

  /** Merge `patch` into an entity, bump `updatedAt` and validate. */
  async update(id: string, patch: Partial<Omit<T, 'id' | 'createdAt'>>): Promise<T> {
    return this.driver.transaction(async (tx) => {
      const existing = await this.getWith(tx, id, true);
      if (!existing) throw new TrailPackError('not_found', `${this.table}/${id} not found`);
      const merged = this.validate({
        ...existing,
        ...patch,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: this.bumped(existing.updatedAt),
      });
      await this.writeRow(tx, merged);
      await this.track(tx, merged.deletedAt ? 'delete' : 'upsert', merged);
      return merged;
    });
  }

  /**
   * Insert or replace an entity verbatim (timestamps are kept). With
   * `fromSync` the write is not queued for upload.
   */
  async upsert(input: T, opts: WriteOptions = {}): Promise<T> {
    const entity = this.validate(input);
    return this.driver.transaction(async (tx) => {
      await this.writeRow(tx, entity);
      if (!opts.fromSync) await this.track(tx, entity.deletedAt ? 'delete' : 'upsert', entity);
      return entity;
    });
  }

  /** Soft delete. Returns the tombstoned entity (pass its id to `restore` for undo). */
  async softDelete(id: string): Promise<T | undefined> {
    return this.driver.transaction(async (tx) => {
      const existing = await this.getWith(tx, id, false);
      if (!existing) return undefined;
      const now = this.bumped(existing.updatedAt);
      const tomb = this.validate({ ...existing, deletedAt: now, updatedAt: now });
      await this.writeRow(tx, tomb);
      await this.track(tx, 'delete', tomb);
      return tomb;
    });
  }

  /** Undo a soft delete. Returns undefined when the id is unknown. */
  async restore(id: string): Promise<T | undefined> {
    return this.driver.transaction(async (tx) => {
      const existing = await this.getWith(tx, id, true);
      if (!existing) return undefined;
      if (!existing.deletedAt) return existing;
      const restored = this.validate({ ...existing, deletedAt: null, updatedAt: this.bumped(existing.updatedAt) });
      await this.writeRow(tx, restored);
      await this.track(tx, 'upsert', restored);
      return restored;
    });
  }

  /** Permanently remove a row. A tombstone is queued so other devices drop it too. */
  async hardDelete(id: string, opts: WriteOptions = {}): Promise<boolean> {
    return this.driver.transaction(async (tx) => {
      const existing = await this.getWith(tx, id, true);
      if (!existing) return false;
      await tx.run(`DELETE FROM ${this.table} WHERE id = ?`, [id]);
      if (!opts.fromSync) {
        const now = this.bumped(existing.updatedAt);
        await this.track(tx, 'delete', { ...existing, deletedAt: existing.deletedAt ?? now, updatedAt: now });
      }
      return true;
    });
  }

  // ---- internals ---------------------------------------------------------

  /** New updatedAt: now, but never earlier than the previous value (clock skew). */
  private bumped(previous: string): string {
    const now = this.ctx.now();
    return Date.parse(now) > Date.parse(previous) ? now : new Date(Date.parse(previous) + 1).toISOString();
  }

  private validate(candidate: unknown): T {
    const r = this.schema.safeParse(candidate);
    if (!r.success) {
      throw new TrailPackError('invalid_input', `Invalid ${this.table}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, {
        details: r.error.issues,
      });
    }
    return r.data;
  }

  private async getWith(driver: SqlDriver, id: string, includeDeleted: boolean): Promise<T | undefined> {
    const row = await driver.get<RawRow>(
      `SELECT data FROM ${this.table} WHERE id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
      [id],
    );
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  private async track(tx: SqlDriver, op: OutboxOp, row: EntityBase): Promise<void> {
    if (this.ctx.tracker.enabled) await this.ctx.tracker.record(tx, this.table, op, row);
  }

  private async writeRow(tx: SqlDriver, entity: T): Promise<void> {
    const raw = entity as unknown as Record<string, unknown>;
    const columns = ['id', 'data', 'created_at', 'updated_at', 'deleted_at', ...this.indexed.map((c) => c.column)];
    const values: SqlValue[] = [
      entity.id,
      JSON.stringify(entity),
      entity.createdAt,
      entity.updatedAt,
      entity.deletedAt ?? null,
      ...this.indexed.map((c) => {
        const v = raw[c.field];
        return v === undefined || v === null ? null : String(v);
      }),
    ];
    const updates = columns.slice(1).map((c) => `${c} = excluded.${c}`);
    await tx.run(
      `INSERT INTO ${this.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
       ON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}`,
      values,
    );
  }

  /** SQL expression for a field: base column, indexed column or JSON path. */
  private fieldExpr(field: string): string {
    if (!FIELD_RE.test(field)) throw new TrailPackError('invalid_input', `Invalid field name "${field}"`);
    const base = BASE_COLUMNS[field];
    if (base) return base;
    const idx = this.indexed.find((c) => c.field === field);
    if (idx) return idx.column;
    return `json_extract(data, '$.${field}')`;
  }

  private selectSql(select: string, opts: ListOptions, withOrder = true): { sql: string; params: SqlValue[] } {
    const params: SqlValue[] = [];
    const clauses: string[] = [];
    if (!opts.includeDeleted) clauses.push('deleted_at IS NULL');
    for (const [field, value] of Object.entries(opts.where ?? {})) {
      if (value === undefined) continue;
      const expr = this.fieldExpr(field);
      if (value === null) {
        clauses.push(`${expr} IS NULL`);
      } else if (Array.isArray(value)) {
        if (value.length === 0) clauses.push('0');
        else {
          clauses.push(`${expr} IN (${value.map(() => '?').join(', ')})`);
          params.push(...(value as (string | number)[]));
        }
      } else {
        clauses.push(`${expr} = ?`);
        params.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value as string | number));
      }
    }
    let sql = `SELECT ${select} FROM ${this.table}`;
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    if (withOrder) {
      const orders = opts.orderBy ? (Array.isArray(opts.orderBy) ? opts.orderBy : [opts.orderBy]) : [{ field: 'createdAt' }];
      const parts = (orders as readonly OrderBy[]).map((o) => `${this.fieldExpr(o.field)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`);
      parts.push('id ASC');
      sql += ` ORDER BY ${parts.join(', ')}`;
      if (opts.limit !== undefined || opts.offset !== undefined) {
        sql += ' LIMIT ? OFFSET ?';
        params.push(opts.limit !== undefined ? Math.max(0, Math.floor(opts.limit)) : -1, Math.max(0, Math.floor(opts.offset ?? 0)));
      }
    }
    return { sql, params };
  }
}
