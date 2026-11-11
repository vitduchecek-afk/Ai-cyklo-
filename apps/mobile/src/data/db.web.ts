import { createDatabase, SqlJsDriver, type SqlJsDatabaseLike, type TrailPackDatabase } from '@trailpack/database';
import { uuid } from '@trailpack/shared';
import initSqlJs from 'sql.js';

const IDB_NAME = 'trailpack';
const STORE = 'kv';
const KEY = 'sqlite';

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadBytes(): Promise<Uint8Array | undefined> {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const r = db.transaction(STORE).objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve(r.result as Uint8Array | undefined);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return undefined;
  }
}

async function saveBytes(bytes: Uint8Array): Promise<void> {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(bytes, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deviceId(): string {
  try {
    const existing = localStorage.getItem('trailpack.deviceId');
    if (existing) return existing;
    const id = uuid();
    localStorage.setItem('trailpack.deviceId', id);
    return id;
  } catch {
    return uuid();
  }
}

let promise: Promise<TrailPackDatabase> | null = null;

/** Singleton database (sql.js in memory, persisted to IndexedDB). */
export function getDb(): Promise<TrailPackDatabase> {
  promise ??= (async () => {
    const SQL = await initSqlJs({ locateFile: () => '/sql-wasm.wasm' });
    const saved = await loadBytes();
    const raw = saved ? new SQL.Database(saved) : new SQL.Database();
    const driver = new SqlJsDriver(raw as unknown as SqlJsDatabaseLike, { persist: saveBytes });
    const db = createDatabase(driver, { deviceId: deviceId() });
    await db.migrate();
    return db;
  })();
  return promise;
}
