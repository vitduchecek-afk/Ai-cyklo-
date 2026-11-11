/**
 * Cache abstraction used by provider adapters. The in-memory LRU is the
 * default; the app plugs a persistent implementation (SQLite) so that weather,
 * POIs and routes stay available offline with their retrieval timestamp.
 */
export interface CacheEntry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

export interface KeyValueCache {
  get<T>(key: string): Promise<CacheEntry<T> | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(prefix?: string): Promise<void>;
  size(): Promise<number>;
}

export class MemoryCache implements KeyValueCache {
  private map = new Map<string, CacheEntry<unknown>>();
  constructor(private readonly maxEntries = 500) {}

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const e = this.map.get(key);
    if (!e) return undefined;
    // refresh LRU position
    this.map.delete(key);
    this.map.set(key, e);
    return e as CacheEntry<T>;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const now = Date.now();
    this.map.delete(key);
    this.map.set(key, { value, storedAt: now, expiresAt: now + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async clear(prefix?: string): Promise<void> {
    if (!prefix) {
      this.map.clear();
      return;
    }
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
  }

  async size(): Promise<number> {
    return this.map.size;
  }
}

export interface CachedResult<T> {
  value: T;
  /** true when served from cache */
  fromCache: boolean;
  /** true when the cached value is past its TTL (served because the network failed) */
  stale: boolean;
  storedAt: number;
}

/**
 * Fetch-through cache with stale-if-error semantics: when the loader fails
 * (offline, provider down) an expired cached value is returned and flagged
 * `stale`, so the UI can show "data from <time>".
 */
export async function cached<T>(
  cache: KeyValueCache | undefined,
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  opts: { forceRefresh?: boolean } = {},
): Promise<CachedResult<T>> {
  if (!cache) {
    const value = await loader();
    return { value, fromCache: false, stale: false, storedAt: Date.now() };
  }
  const hit = await cache.get<T>(key);
  if (hit && !opts.forceRefresh && hit.expiresAt > Date.now()) {
    return { value: hit.value, fromCache: true, stale: false, storedAt: hit.storedAt };
  }
  try {
    const value = await loader();
    await cache.set(key, value, ttlMs);
    return { value, fromCache: false, stale: false, storedAt: Date.now() };
  } catch (e) {
    if (hit) return { value: hit.value, fromCache: true, stale: true, storedAt: hit.storedAt };
    throw e;
  }
}

/** Stable cache key from arbitrary JSON-serialisable input. */
export function cacheKey(prefix: string, input: unknown): string {
  return `${prefix}:${stableStringify(input)}`;
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}
