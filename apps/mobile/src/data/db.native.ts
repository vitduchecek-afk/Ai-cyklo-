import { createDatabase, createExpoSqliteDriver, type ExpoSqliteDatabaseLike, type TrailPackDatabase } from '@trailpack/database';
import { uuid } from '@trailpack/shared';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';

let promise: Promise<TrailPackDatabase> | null = null;

async function deviceId(): Promise<string> {
  try {
    const existing = await SecureStore.getItemAsync('trailpack.deviceId');
    if (existing) return existing;
    const id = uuid();
    await SecureStore.setItemAsync('trailpack.deviceId', id);
    return id;
  } catch {
    return uuid();
  }
}

/** Singleton database (expo-sqlite, migrated on first use). */
export function getDb(): Promise<TrailPackDatabase> {
  promise ??= (async () => {
    const raw = await SQLite.openDatabaseAsync('trailpack.db');
    const driver = createExpoSqliteDriver(raw as unknown as ExpoSqliteDatabaseLike);
    const db = createDatabase(driver, { deviceId: await deviceId() });
    await db.migrate();
    return db;
  })();
  return promise;
}
