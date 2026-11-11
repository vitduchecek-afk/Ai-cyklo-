/**
 * Minimal async SQL driver abstraction. The database layer only talks to this
 * interface, so the same code runs on expo-sqlite (device), sql.js (web / tests)
 * and node:sqlite (tests, server tooling).
 *
 * This file must stay free of `node:` imports – it is bundled by Metro.
 */

export type SqlValue = string | number | null | Uint8Array;

export interface RunResult {
  /** Number of rows inserted / updated / deleted by the statement. */
  changes: number;
}

export interface SqlDriver {
  /** Execute one or more statements without parameters (DDL, pragmas). */
  exec(sql: string): Promise<void>;
  /** Execute a single write statement. */
  run(sql: string, params?: readonly SqlValue[]): Promise<RunResult>;
  /** Run a query and return all rows as plain objects. */
  all<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  /** Run a query and return the first row, if any. */
  get<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined>;
  /**
   * Run `fn` atomically. Commits when `fn` resolves, rolls back when it
   * rejects. The `tx` handle must be used for every statement inside `fn`.
   * Nested calls on `tx` use savepoints.
   */
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Minimal promise based mutex used to serialise access to a single connection. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Run `fn` after every previously queued task finished. */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Ensures parameter arrays never contain `undefined` (rejected by every engine). */
export function normalizeParams(params: readonly (SqlValue | undefined | boolean)[] | undefined): SqlValue[] {
  if (!params) return [];
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

/**
 * Base class for synchronous engines (sql.js, node:sqlite). Statements of a
 * transaction are serialised with a mutex so that concurrent callers sharing
 * one connection can never interleave inside somebody else's transaction.
 */
export abstract class SyncSqlDriver implements SqlDriver {
  private readonly mutex = new Mutex();
  private savepointCounter = 0;

  protected abstract rawExec(sql: string): void;
  protected abstract rawRun(sql: string, params: SqlValue[]): RunResult;
  protected abstract rawAll(sql: string, params: SqlValue[]): Record<string, SqlValue>[];
  protected abstract rawClose(): void;
  /** Called after every successful top-level write (used for persistence). */
  protected onWrite(): void {}

  exec(sql: string): Promise<void> {
    return this.mutex.run(() => {
      this.rawExec(sql);
      this.onWrite();
    });
  }

  run(sql: string, params?: readonly SqlValue[]): Promise<RunResult> {
    return this.mutex.run(() => {
      const r = this.rawRun(sql, normalizeParams(params));
      this.onWrite();
      return r;
    });
  }

  all<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
    return this.mutex.run(() => this.rawAll(sql, normalizeParams(params)) as unknown as T[]);
  }

  async get<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined> {
    return (await this.all<T>(sql, params))[0];
  }

  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      this.rawExec('BEGIN IMMEDIATE');
      try {
        const result = await fn(this.createTxDriver());
        this.rawExec('COMMIT');
        this.onWrite();
        return result;
      } catch (e) {
        try {
          this.rawExec('ROLLBACK');
        } catch {
          // connection already rolled back / closed – original error is more useful
        }
        throw e;
      }
    });
  }

  async close(): Promise<void> {
    await this.mutex.run(() => this.rawClose());
  }

  /** Driver handed to transaction callbacks: runs directly on the locked connection. */
  private createTxDriver(): SqlDriver {
    const self = this;
    const tx: SqlDriver = {
      async exec(sql) {
        self.rawExec(sql);
      },
      async run(sql, params) {
        return self.rawRun(sql, normalizeParams(params));
      },
      async all<T>(sql: string, params?: readonly SqlValue[]) {
        return self.rawAll(sql, normalizeParams(params)) as unknown as T[];
      },
      async get<T>(sql: string, params?: readonly SqlValue[]) {
        return (self.rawAll(sql, normalizeParams(params)) as unknown as T[])[0];
      },
      async transaction<T>(fn: (t: SqlDriver) => Promise<T>) {
        const name = `sp_${++self.savepointCounter}`;
        self.rawExec(`SAVEPOINT ${name}`);
        try {
          const r = await fn(tx);
          self.rawExec(`RELEASE ${name}`);
          return r;
        } catch (e) {
          self.rawExec(`ROLLBACK TO ${name}`);
          self.rawExec(`RELEASE ${name}`);
          throw e;
        }
      },
      async close() {
        throw new Error('Cannot close the database inside a transaction');
      },
    };
    return tx;
  }
}
