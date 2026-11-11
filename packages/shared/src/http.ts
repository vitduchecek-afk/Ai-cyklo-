/**
 * Small, dependency-free HTTP client used by every external provider adapter.
 * Features: timeouts, abort propagation, retries with exponential backoff for
 * retryable failures, per-host throttling (e.g. Nominatim 1 req/s policy),
 * JSON parsing with error normalisation, and an injectable `fetch` for tests.
 */
import { TrailPackError, errorCodeForStatus, toTrailPackError } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  fetch?: FetchLike;
  /** Default timeout per request (ms). */
  timeoutMs?: number;
  /** Retries for retryable errors (network / 429 / 5xx). */
  retries?: number;
  /** Identifies the app to public APIs (OSM services require it). */
  userAgent?: string;
  /** Minimum interval between requests per host (ms). */
  minIntervalMsPerHost?: Record<string, number>;
  /** Returns false when the device is known to be offline. */
  isOnline?: () => boolean;
  /** Optional hook for diagnostics. */
  onRequest?: (info: { url: string; method: string; status?: number; ms: number; error?: string }) => void;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  provider?: string;
  /** Raw string body (e.g. Overpass QL). */
  rawBody?: string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new TrailPackError('aborted', 'Request aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new TrailPackError('aborted', 'Request aborted'));
      },
      { once: true },
    );
  });

export const DEFAULT_USER_AGENT = 'TrailPack/1.0 (+https://github.com/trailpack-app)';

export class HttpClient {
  private readonly opts: Required<Omit<HttpClientOptions, 'isOnline' | 'onRequest' | 'fetch'>> &
    Pick<HttpClientOptions, 'isOnline' | 'onRequest'> & { fetch: FetchLike };
  private readonly lastRequestAt = new Map<string, number>();
  private readonly hostQueues = new Map<string, Promise<void>>();

  constructor(options: HttpClientOptions = {}) {
    const f = options.fetch ?? (globalThis.fetch?.bind(globalThis) as FetchLike | undefined);
    if (!f) throw new TrailPackError('unsupported', 'fetch is not available in this runtime');
    this.opts = {
      fetch: f,
      timeoutMs: options.timeoutMs ?? 20000,
      retries: options.retries ?? 2,
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      minIntervalMsPerHost: options.minIntervalMsPerHost ?? {
        'nominatim.openstreetmap.org': 1100,
        'overpass-api.de': 1000,
        'brouter.de': 500,
        'valhalla1.openstreetmap.de': 500,
      },
      isOnline: options.isOnline,
      onRequest: options.onRequest,
    };
  }

  private async throttle(url: string, signal?: AbortSignal): Promise<void> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return;
    }
    const interval = this.opts.minIntervalMsPerHost[host];
    if (!interval) return;
    const prev = this.hostQueues.get(host) ?? Promise.resolve();
    const next = prev.then(async () => {
      const last = this.lastRequestAt.get(host) ?? 0;
      const wait = last + interval - Date.now();
      if (wait > 0) await sleep(wait, signal);
      this.lastRequestAt.set(host, Date.now());
    });
    this.hostQueues.set(
      host,
      next.catch(() => undefined),
    );
    await next;
  }

  async request(url: string, options: RequestOptions = {}): Promise<Response> {
    const method = options.method ?? (options.body !== undefined || options.rawBody !== undefined ? 'POST' : 'GET');
    const retries = options.retries ?? this.opts.retries;
    const provider = options.provider;
    if (this.opts.isOnline && !this.opts.isOnline()) {
      throw new TrailPackError('offline', 'Device is offline', { provider });
    }
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const started = Date.now();
      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs;
      const timer = setTimeout(() => controller.abort(new TrailPackError('timeout', `Timed out after ${timeoutMs} ms`)), timeoutMs);
      const onOuterAbort = () => controller.abort(new TrailPackError('aborted', 'Request aborted'));
      if (options.signal) {
        if (options.signal.aborted) {
          clearTimeout(timer);
          throw new TrailPackError('aborted', 'Request aborted', { provider });
        }
        options.signal.addEventListener('abort', onOuterAbort, { once: true });
      }
      try {
        await this.throttle(url, options.signal);
        const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
        // Browsers forbid setting User-Agent; native/Node honour it.
        if (typeof navigator === 'undefined' || (navigator as { product?: string }).product === 'ReactNative') {
          headers['User-Agent'] ??= this.opts.userAgent;
        }
        let body: string | undefined;
        if (options.rawBody !== undefined) body = options.rawBody;
        else if (options.body !== undefined) {
          body = JSON.stringify(options.body);
          headers['Content-Type'] ??= 'application/json';
        }
        const res = await this.opts.fetch(url, { method, headers, body, signal: controller.signal });
        this.opts.onRequest?.({ url: redactUrl(url), method, status: res.status, ms: Date.now() - started });
        if (!res.ok) {
          const text = await safeText(res);
          const code = errorCodeForStatus(res.status);
          const retryable = res.status === 429 || res.status >= 500;
          const error = new TrailPackError(code, `HTTP ${res.status}: ${truncate(text, 300)}`, {
            provider,
            status: res.status,
            retryable,
            details: truncate(text, 2000),
          });
          if (retryable && attempt < retries) {
            attempt++;
            const retryAfter = Number(res.headers.get('retry-after'));
            await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30000) : backoff(attempt), options.signal);
            continue;
          }
          throw error;
        }
        return res;
      } catch (e) {
        let error: TrailPackError;
        const reason = controller.signal.reason;
        if (controller.signal.aborted && reason instanceof TrailPackError) error = new TrailPackError(reason.code, reason.message, { provider, cause: e });
        else error = toTrailPackError(e, provider);
        if (error.provider === undefined && provider) (error as { provider?: string }).provider = provider;
        this.opts.onRequest?.({ url: redactUrl(url), method, ms: Date.now() - started, error: error.code });
        if (error.retryable && error.code !== 'offline' && attempt < retries && !options.signal?.aborted && error.status === undefined) {
          attempt++;
          await sleep(backoff(attempt), options.signal);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onOuterAbort);
      }
    }
  }

  async json<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.request(url, options);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new TrailPackError('parse_error', `Invalid JSON from ${options.provider ?? 'provider'}: ${truncate(text, 200)}`, {
        provider: options.provider,
        cause: e,
      });
    }
  }

  async text(url: string, options: RequestOptions = {}): Promise<string> {
    const res = await this.request(url, options);
    return res.text();
  }
}

const backoff = (attempt: number) => Math.min(500 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 200);

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Remove secrets (api keys, tokens) from URLs before logging. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:api[_-]?key|apikey|key|token|access_token|appid)=)[^&]+/gi, '$1***');
}

/** Build a URL with query parameters, skipping undefined values. */
export function buildUrl(base: string, params: Record<string, string | number | boolean | undefined | null | Array<string | number>>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return url.toString();
}
