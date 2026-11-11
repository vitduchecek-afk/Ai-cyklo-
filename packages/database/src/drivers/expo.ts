/**
 * Adapter for expo-sqlite's async API. The database object is typed
 * structurally so this package does not depend on expo-sqlite.
 */
import { normalizeParams, type RunResult, type SqlDriver, type SqlValue } from '../driver';

/** Statement surface shared by `SQLiteDatabase` and the transaction handle. */
export interface ExpoStatementApi {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: SqlValue[]): Promise<{ changes: number }>;
  getAllAsync<T>(sql: string, params: SqlValue[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params: SqlValue[]): Promise<T | null>;
}

export interface ExpoSqliteDatabaseLike extends ExpoStatementApi {
  /** Preferred: runs on a dedicated connection, other statements wait. */
  withExclusiveTransactionAsync?(task: (txn: ExpoStatementApi) => Promise<void>): Promise<void>;
  /** Fallback: statements run on the main connection. */
  withTransactionAsync?(task: () => Promise<void>): Promise<void>;
  closeAsync(): Promise<void>;
}

function wrap(api: ExpoStatementApi, transaction: SqlDriver['transaction'], close: () => Promise<void>): SqlDriver {
  return {
    exec: (sql) => api.execAsync(sql),
    async run(sql, params): Promise<RunResult> {
      const r = await api.runAsync(sql, normalizeParams(params));
      return { changes: r.changes };
    },
    all: <T>(sql: string, params?: readonly SqlValue[]) => api.getAllAsync<T>(sql, normalizeParams(params)),
    async get<T>(sql: string, params?: readonly SqlValue[]) {
      return (await api.getFirstAsync<T>(sql, normalizeParams(params))) ?? undefined;
    },
    transaction,
    close,
  };
}

/** Wrap an opened expo-sqlite database (`SQLite.openDatabaseAsync(...)`). */
export function createExpoSqliteDriver(db: ExpoSqliteDatabaseLike): SqlDriver {
  let savepoints = 0;

  const makeTx = (api: ExpoStatementApi): SqlDriver => {
    const tx: SqlDriver = wrap(
      api,
      async <T>(fn: (t: SqlDriver) => Promise<T>) => {
        const name = `sp_${++savepoints}`;
        await api.execAsync(`SAVEPOINT ${name}`);
        try {
          const r = await fn(tx);
          await api.execAsync(`RELEASE ${name}`);
          return r;
        } catch (e) {
          await api.execAsync(`ROLLBACK TO ${name}`);
          await api.execAsync(`RELEASE ${name}`);
          throw e;
        }
      },
      async () => {
        throw new Error('Cannot close the database inside a transaction');
      },
    );
    return tx;
  };

  const root: SqlDriver = wrap(
    db,
    async <T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> => {
      let result: T | undefined;
      let done = false;
      if (db.withExclusiveTransactionAsync) {
        await db.withExclusiveTransactionAsync(async (txn) => {
          result = await fn(makeTx(txn));
          done = true;
        });
      } else if (db.withTransactionAsync) {
        await db.withTransactionAsync(async () => {
          result = await fn(makeTx(db));
          done = true;
        });
      } else {
        throw new Error('expo-sqlite database exposes no transaction API');
      }
      if (!done) throw new Error('Transaction did not complete');
      return result as T;
    },
    () => db.closeAsync(),
  );
  return root;
}
