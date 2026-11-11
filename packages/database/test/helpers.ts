import { NodeSqliteDriver } from '../src/node';
import { SqlJsDriver, type SqlJsDatabaseLike } from '../src/drivers/sqljs';
import { createDatabase, type CreateDatabaseOptions, type TrailPackDatabase } from '../src/database';
import type { SqlDriver } from '../src/driver';

export type DriverFactory = () => Promise<SqlDriver>;

export const DRIVERS: ReadonlyArray<readonly [string, DriverFactory]> = [
  ['node:sqlite', async () => new NodeSqliteDriver()],
  [
    'sql.js',
    async () => {
      const initSqlJs = (await import('sql.js')).default;
      const SQL = await initSqlJs();
      return new SqlJsDriver(new SQL.Database() as unknown as SqlJsDatabaseLike);
    },
  ],
];

/** Controllable millisecond clock. */
export function fakeClock(start = '2026-03-01T10:00:00.000Z') {
  let t = Date.parse(start);
  return { now: () => t, advance: (ms: number) => (t += ms), set: (v: number) => (t = v) };
}

export async function makeDb(
  factory: DriverFactory,
  opts: Partial<CreateDatabaseOptions> = {},
): Promise<{ db: TrailPackDatabase; driver: SqlDriver; clock: ReturnType<typeof fakeClock> }> {
  const driver = await factory();
  const clock = fakeClock();
  let n = 0;
  const db = createDatabase(driver, { deviceId: 'dev-A', clock: clock.now, newId: () => `id-${++n}`, ...opts });
  await db.migrate();
  return { db, driver, clock };
}

export const tripDraft = (name = 'Šumava') => ({ name, activityType: 'hiking' as const });
