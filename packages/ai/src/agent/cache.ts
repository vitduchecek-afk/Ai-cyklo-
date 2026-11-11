/**
 * Response cache for deterministic, side-effect free model calls (image
 * analysis, summaries, plan extraction). Keyed by a stable hash of
 * provider / model / system / messages / tools; in-memory LRU with TTL and an
 * optional persistent {@link KeyValueCache} second tier.
 */
import { stableStringify, type KeyValueCache } from '@trailpack/shared';
import type { ChatRequest, ChatResponse, ChatTransport } from '../types';

export interface ResponseCacheOptions {
  /** Time to live in ms. Default 1 hour. */
  ttlMs?: number;
  /** Maximum in-memory entries (least recently used are evicted). Default 100. */
  maxEntries?: number;
  /** Optional persistent tier (e.g. SQLite) used on memory misses. */
  store?: KeyValueCache;
  /** Clock override for tests. */
  now?: () => number;
}

interface Entry {
  value: ChatResponse;
  expiresAt: number;
}

/** 53-bit string hash (cyrb53) – fast and stable across platforms. */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export class ResponseCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly store?: KeyValueCache;
  private readonly now: () => number;
  private readonly map = new Map<string, Entry>();

  constructor(options: ResponseCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 3_600_000;
    this.maxEntries = Math.max(1, options.maxEntries ?? 100);
    this.store = options.store;
    this.now = options.now ?? Date.now;
  }

  /** Stable key for a request (independent of object key order). */
  key(request: ChatRequest): string {
    const canonical = stableStringify({
      provider: request.provider,
      model: request.model,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      maxTokens: request.maxTokens,
      effort: request.effort,
      baseUrl: request.baseUrl,
    });
    return `ai:${hashString(canonical)}${hashString(canonical, 7)}:${canonical.length}`;
  }

  async get(request: ChatRequest): Promise<ChatResponse | undefined> {
    const key = this.key(request);
    const hit = this.map.get(key);
    if (hit) {
      if (hit.expiresAt > this.now()) {
        this.map.delete(key);
        this.map.set(key, hit); // refresh LRU position
        return structuredClone(hit.value);
      }
      this.map.delete(key);
    }
    if (this.store) {
      try {
        const persisted = await this.store.get<ChatResponse>(key);
        if (persisted && persisted.expiresAt > this.now()) {
          this.remember(key, persisted.value, persisted.expiresAt);
          return structuredClone(persisted.value);
        }
      } catch {
        // a broken persistent tier must never break AI calls
      }
    }
    return undefined;
  }

  async set(request: ChatRequest, response: ChatResponse, ttlMs: number = this.ttlMs): Promise<void> {
    const key = this.key(request);
    this.remember(key, structuredClone(response), this.now() + ttlMs);
    if (this.store) {
      try {
        await this.store.set(key, response, ttlMs);
      } catch {
        // ignore persistence failures
      }
    }
  }

  /** Number of live in-memory entries. */
  get size(): number {
    return this.map.size;
  }

  async clear(): Promise<void> {
    this.map.clear();
    try {
      await this.store?.clear('ai:');
    } catch {
      // ignore
    }
  }

  /** Wrap a transport so identical requests are answered from the cache. Only clean `end` responses are stored. */
  wrap(transport: ChatTransport): ChatTransport {
    return {
      chat: async (request, signal) => {
        const cached = await this.get(request);
        if (cached) return { ...cached, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }; // a hit costs nothing
        const response = await transport.chat(request, signal);
        if (response.stopReason === 'end' && !response.message.parts.some((p) => p.type === 'tool_call')) await this.set(request, response);
        return response;
      },
    };
  }

  private remember(key: string, value: ChatResponse, expiresAt: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }
}
