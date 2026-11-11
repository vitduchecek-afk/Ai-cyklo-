/**
 * node:sqlite driver for tests, scripts and server-side tooling.
 *
 * NOT exported from the package root (`@trailpack/database`) because Metro
 * cannot bundle Node built-ins – import it from `@trailpack/database/node`.
 */
import { DatabaseSync } from 'node:sqlite';
import { SyncSqlDriver, type RunResult, type SqlValue } from './driver';

export interface NodeSqliteOptions {
  /** File path or ':memory:' (default). */
  path?: string;
  /** Enable write-ahead logging for file databases (default true). */
  wal?: boolean;
}

export class NodeSqliteDriver extends SyncSqlDriver {
  private readonly db: DatabaseSync;

  constructor(options: NodeSqliteOptions | DatabaseSync = {}) {
    super();
    if (options instanceof DatabaseSync) {
      this.db = options;
    } else {
      const path = options.path ?? ':memory:';
      this.db = new DatabaseSync(path);
      if (path !== ':memory:' && options.wal !== false) this.db.exec('PRAGMA journal_mode = WAL');
    }
    this.db.exec('PRAGMA foreign_keys = OFF');
  }

  protected rawExec(sql: string): void {
    this.db.exec(sql);
  }

  protected rawRun(sql: string, params: SqlValue[]): RunResult {
    const r = this.db.prepare(sql).run(...params);
    return { changes: Number(r.changes) };
  }

  protected rawAll(sql: string, params: SqlValue[]): Record<string, SqlValue>[] {
    // node:sqlite returns null-prototype objects; copy into plain objects.
    return this.db.prepare(sql).all(...params).map((row) => ({ ...row })) as Record<string, SqlValue>[];
  }

  protected rawClose(): void {
    if (this.db.isOpen) this.db.close();
  }
}
