/**
 * In-memory token bucket rate limiter. Each key gets `capacity` tokens that
 * refill continuously over `windowMs`. Suitable for a single instance; run
 * behind a gateway limiter when scaling horizontally.
 */
export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  /** Seconds until one more request is allowed (0 when ok). */
  retryAfterSec: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly refillPerMs: number;

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {
    this.refillPerMs = capacity / windowMs;
  }

  take(key: string): RateLimitResult {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.sweep(t);
      b = { tokens: this.capacity, updated: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.capacity, b.tokens + (t - b.updated) * this.refillPerMs);
      b.updated = t;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, remaining: Math.floor(b.tokens), retryAfterSec: 0 };
    }
    return { ok: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / this.refillPerMs / 1000)) };
  }

  /** Drop buckets that have fully refilled (they are indistinguishable from new ones). */
  private sweep(t: number): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens + (t - b.updated) * this.refillPerMs >= this.capacity) this.buckets.delete(k);
    }
    // Still full of active keys: evict the oldest to bound memory.
    if (this.buckets.size >= this.maxKeys) {
      const excess = this.buckets.size - Math.floor(this.maxKeys * 0.9);
      let i = 0;
      for (const k of this.buckets.keys()) {
        if (i++ >= excess) break;
        this.buckets.delete(k);
      }
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
