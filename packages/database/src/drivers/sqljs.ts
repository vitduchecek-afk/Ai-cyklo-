/**
 * sql.js (WASM SQLite) driver for web builds and tests. The database lives in
 * memory; `persist` receives the serialised file after writes (debounced) so
 * the host can store it in IndexedDB / OPFS.
 */
import { SyncSqlDriver, type RunResult, type SqlValue } from '../driver';

/** Structural subset of sql.js `Database` – avoids a hard dependency on its types. */
export interface SqlJsDatabaseLike {
  run(sql: string, params?: SqlValue[]): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): {
    bind(params?: SqlValue[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, SqlValue>;
    free(): boolean;
  };
  getRowsModified(): number;
  export(): Uint8Array;
  close(): void;
}

export interface SqlJsDriverOptions {
  /** Called with the serialised database after writes. */
  persist?: (bytes: Uint8Array) => Promise<void>;
  /** Debounce for `persist` (default 750 ms). */
  persistDebounceMs?: number;
  /** Called when `persist` rejects (default: console.error). */
  onPersistError?: (error: unknown) => void;
}

export class SqlJsDriver extends SyncSqlDriver {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: SqlJsDatabaseLike,
    private readonly options: SqlJsDriverOptions = {},
  ) {
    super();
  }

  protected rawExec(sql: string): void {
    this.db.exec(sql);
  }

  protected rawRun(sql: string, params: SqlValue[]): RunResult {
    this.db.run(sql, params);
    return { changes: this.db.getRowsModified() };
  }

  protected rawAll(sql: string, params: SqlValue[]): Record<string, SqlValue>[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows: Record<string, SqlValue>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  protected rawClose(): void {
    this.db.close();
  }

  protected override onWrite(): void {
    if (!this.options.persist) return;
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.options.persistDebounceMs ?? 750);
  }

  /** Persist immediately (no-op when nothing changed since the last flush). */
  async flush(): Promise<void> {
    const persist = this.options.persist;
    if (!persist) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.inflight = this.inflight.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      try {
        await persist(this.db.export());
      } catch (e) {
        this.dirty = true;
        (this.options.onPersistError ?? ((err) => console.error('[database] persist failed', err)))(e);
      }
    });
    await this.inflight;
  }

  override async close(): Promise<void> {
    await this.flush();
    await super.close();
  }
}
