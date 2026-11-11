/**
 * Small HTTP layer shared by the AI provider adapters.
 *
 * Why not `HttpClient` from `@trailpack/shared`? LLM calls have different
 * needs: multi-minute timeouts, provider specific error bodies that must be
 * turned into localised `TrailPackError`s, `retry-after` / `x-should-retry`
 * handling with the delay exposed to the UI, and strict secret redaction
 * (API keys travel in headers and some providers echo partial keys back in
 * error messages). Everything goes through an injectable `fetch`, so the same
 * code runs in Node, browsers and React Native and is testable without
 * network access.
 */
import { TrailPackError, type FetchLike } from '@trailpack/shared';

/** HTTP behaviour shared by all transports. */
export interface TransportHttpOptions {
  /** Injectable fetch (tests, React Native polyfills). Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Per-attempt timeout in ms. Default 600 000 (10 min) – reasoning models can think for minutes. */
  timeoutMs?: number;
  /** Retries for retryable failures (429, 408, 5xx/529, network). Default 2. */
  retries?: number;
  /** Base delay for exponential backoff in ms. Default 1000. */
  retryBaseDelayMs?: number;
  /** Longest `retry-after` the transport waits inside one call; longer waits fail fast with `rate_limited`. Default 30 000. */
  maxRetryAfterMs?: number;
}

/** Fully resolved {@link TransportHttpOptions}. */
export interface ResolvedHttpOptions {
  fetch: FetchLike;
  timeoutMs: number;
  retries: number;
  retryBaseDelayMs: number;
  maxRetryAfterMs: number;
}

/** A non-2xx HTTP response handed to a provider specific error mapper. */
export interface HttpFailure {
  status: number;
  /** Parsed JSON body, `undefined` when the body is not JSON. */
  body: unknown;
  /** Raw body text with secrets redacted. */
  text: string;
  headers: Headers;
  /** Delay requested by the server (`retry-after-ms` / `retry-after`). */
  retryAfterMs?: number;
}

/** One logical request to a provider. */
export interface ProviderCall {
  /** Provider id stored on `TrailPackError.provider` (e.g. `anthropic`). */
  providerId: string;
  /** Human readable provider name used in (Czech) error messages. */
  providerLabel: string;
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /** Converts an HTTP error response into a `TrailPackError` (set `retryable` to allow retries). */
  mapError: (failure: HttpFailure) => TrailPackError;
  /** Secret values (API keys, tokens) that must never appear in errors. */
  secrets?: string[];
}

export const DEFAULT_CHAT_TIMEOUT_MS = 600_000;
export const DEFAULT_LIST_TIMEOUT_MS = 30_000;

/** Fill in defaults. `fetch` is resolved lazily so constructing a transport never throws. */
export function resolveHttpOptions(options: TransportHttpOptions = {}): ResolvedHttpOptions {
  const injected = options.fetch;
  const fetchImpl: FetchLike = (input, init) => {
    const f = injected ?? (typeof globalThis.fetch === 'function' ? (globalThis.fetch.bind(globalThis) as FetchLike) : undefined);
    if (!f) return Promise.reject(new TrailPackError('unsupported', 'V tomto prostředí není dostupné rozhraní fetch.'));
    return f(input, init);
  };
  return {
    fetch: fetchImpl,
    timeoutMs: positive(options.timeoutMs, DEFAULT_CHAT_TIMEOUT_MS),
    retries: Math.max(0, Math.floor(options.retries ?? 2)),
    retryBaseDelayMs: Math.max(0, options.retryBaseDelayMs ?? 1000),
    maxRetryAfterMs: Math.max(0, options.maxRetryAfterMs ?? 30_000),
  };
}

const positive = (v: number | undefined, fallback: number): number => (v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback);

type AttemptOutcome<T> = { ok: true; data: T; headers: Headers; status: number } | { ok: false; error: TrailPackError; retryDelayMs?: number };

/**
 * Perform a JSON request with timeout, abort propagation, retries and error
 * normalisation. Resolves with the parsed JSON body of a 2xx response; every
 * failure rejects with a `TrailPackError` whose message is safe to show.
 */
export async function callJson<T = unknown>(
  http: ResolvedHttpOptions,
  call: ProviderCall,
  overrides: { timeoutMs?: number } = {},
): Promise<{ data: T; headers: Headers; status: number }> {
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(call.signal, call.providerId);
    const outcome = await attemptOnce<T>(http, call, attempt, overrides.timeoutMs ?? http.timeoutMs);
    if (outcome.ok) return { data: outcome.data, headers: outcome.headers, status: outcome.status };
    if (outcome.retryDelayMs !== undefined && attempt < http.retries && !call.signal?.aborted) {
      await abortableSleep(outcome.retryDelayMs, call.signal, call.providerId);
      continue;
    }
    throw outcome.error;
  }
}

async function attemptOnce<T>(http: ResolvedHttpOptions, call: ProviderCall, attempt: number, timeoutMs: number): Promise<AttemptOutcome<T>> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  call.signal?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    let res: Response;
    let text: string;
    try {
      res = await http.fetch(call.url, {
        method: call.method,
        headers: call.headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (e) {
      if (call.signal?.aborted) return { ok: false, error: abortedError(call.providerId, e) };
      if (timedOut) {
        return {
          ok: false,
          error: new TrailPackError('timeout', `Služba ${call.providerLabel} neodpověděla do ${Math.round(timeoutMs / 1000)} s.`, {
            provider: call.providerId,
            retryable: true,
            cause: e,
          }),
        };
      }
      const error = new TrailPackError('network', `Nelze se spojit se službou ${call.providerLabel}. Zkontrolujte připojení k internetu.`, {
        provider: call.providerId,
        retryable: true,
        details: { reason: redactSecrets(errorMessage(e), call.secrets) },
        cause: e,
      });
      return { ok: false, error, retryDelayMs: backoff(attempt, http.retryBaseDelayMs) };
    }

    if (res.ok) {
      if (!text.trim()) {
        return { ok: false, error: new TrailPackError('provider_error', `Služba ${call.providerLabel} vrátila prázdnou odpověď.`, { provider: call.providerId, status: res.status, retryable: false }) };
      }
      try {
        return { ok: true, data: JSON.parse(text) as T, headers: res.headers, status: res.status };
      } catch (e) {
        return {
          ok: false,
          error: new TrailPackError('provider_error', `Služba ${call.providerLabel} vrátila neplatnou odpověď (není JSON).`, {
            provider: call.providerId,
            status: res.status,
            retryable: false,
            details: { body: truncateText(redactSecrets(text, call.secrets), 300) },
            cause: e,
          }),
        };
      }
    }

    const redacted = redactSecrets(text, call.secrets);
    const failure: HttpFailure = {
      status: res.status,
      body: tryParseJson(redacted),
      text: truncateText(redacted, 4000),
      headers: res.headers,
      retryAfterMs: parseRetryAfter(res.headers),
    };
    const error = call.mapError(failure);
    if ((error as { provider?: string }).provider === undefined) (error as { provider?: string }).provider = call.providerId;
    const shouldRetryHeader = res.headers.get('x-should-retry');
    const retryable = shouldRetryHeader === 'true' ? true : shouldRetryHeader === 'false' ? false : error.retryable;
    if (!retryable) return { ok: false, error };
    const delay = failure.retryAfterMs ?? backoff(attempt, http.retryBaseDelayMs);
    if (delay > http.maxRetryAfterMs) return { ok: false, error };
    return { ok: false, error, retryDelayMs: delay };
  } finally {
    clearTimeout(timer);
    call.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Exponential backoff with jitter: base · 2^attempt (+ up to 25 %), capped at 16 s. */
function backoff(attempt: number, baseMs: number): number {
  if (baseMs <= 0) return 0;
  const raw = Math.min(baseMs * 2 ** attempt, 16_000);
  return Math.round(raw + Math.random() * raw * 0.25);
}

/** Parse `retry-after-ms`, `retry-after` (seconds or HTTP date). */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && ms.trim() !== '') {
    const v = Number(ms);
    if (Number.isFinite(v) && v >= 0) return Math.round(v);
  }
  const ra = headers.get('retry-after');
  if (ra === null || ra.trim() === '') return undefined;
  const seconds = Number(ra);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(ra);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

/** Reject immediately when the caller already aborted. */
export function throwIfAborted(signal: AbortSignal | undefined, provider?: string): void {
  if (signal?.aborted) throw abortedError(provider);
}

/** The canonical "aborted by the user" error. */
export function abortedError(provider?: string, cause?: unknown): TrailPackError {
  return new TrailPackError('aborted', 'Požadavek byl zrušen.', { provider, retryable: false, cause });
}

/** Sleep that rejects with an `aborted` error when the signal fires. */
export function abortableSleep(ms: number, signal?: AbortSignal, provider?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError(provider));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError(provider));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Remove API keys and bearer tokens from arbitrary text. Known secret values
 * are replaced verbatim; well-known key shapes (OpenAI `sk-…`, Anthropic
 * `sk-ant-…`, Google `AIza…`, bearer tokens, `key=` query params) are masked
 * even when the exact value is not known.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined | null)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('***');
  }
  return out
    .replace(/\bsk-ant-[A-Za-z0-9_\-*.]{6,}/g, 'sk-ant-***')
    .replace(/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\-*.]{8,}/g, 'sk-***')
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, 'AIza***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/([?&](?:api[_-]?key|apikey|key|token|access_token)=)[^&\s"']+/gi, '$1***');
}

/** Structured view of a provider error body. */
export interface ApiErrorInfo {
  message?: string;
  type?: string;
  code?: string;
  /** Google error detail reasons (e.g. `API_KEY_INVALID`). */
  reasons?: string[];
  requestId?: string;
}

/**
 * Extract the error message/type from the common provider error envelopes:
 * Anthropic `{type:'error', error:{type,message}}`, OpenAI `{error:{message,type,code}}`,
 * Google `{error:{code,message,status,details:[{reason}]}}`, Ollama `{error:"…"}`,
 * TrailPack proxy `{error:{code,message}}`.
 */
export function extractApiError(body: unknown): ApiErrorInfo {
  if (!isRecord(body)) return {};
  const info: ApiErrorInfo = {};
  if (typeof body.request_id === 'string') info.requestId = body.request_id;
  const err = body.error;
  if (typeof err === 'string') {
    info.message = err;
    return info;
  }
  if (isRecord(err)) {
    if (typeof err.message === 'string') info.message = err.message;
    if (typeof err.type === 'string') info.type = err.type;
    if (typeof err.status === 'string') info.type ??= err.status;
    if (typeof err.code === 'string') info.code = err.code;
    else if (typeof err.code === 'number') info.code = String(err.code);
    if (Array.isArray(err.details)) {
      const reasons = err.details.flatMap((d) => (isRecord(d) && typeof d.reason === 'string' ? [d.reason] : []));
      if (reasons.length) info.reasons = reasons;
    }
  } else if (typeof body.message === 'string') {
    info.message = body.message;
  }
  return info;
}

/**
 * Generic HTTP status → `TrailPackError` mapping with Czech messages.
 * Provider adapters call this after handling their own special cases.
 */
export function mapStatusError(providerId: string, label: string, failure: HttpFailure): TrailPackError {
  const api = extractApiError(failure.body);
  const apiMessage = api.message ? truncateText(api.message, 400) : undefined;
  const suffix = apiMessage ? `: ${apiMessage}` : '.';
  const details = {
    status: failure.status,
    type: api.type,
    code: api.code,
    apiMessage,
    requestId: api.requestId ?? failure.headers.get('request-id') ?? failure.headers.get('x-request-id') ?? undefined,
    retryAfterMs: failure.retryAfterMs,
  };
  const s = failure.status;
  const opts = (retryable: boolean) => ({ provider: providerId, status: s, retryable, details });
  if (s === 401) return new TrailPackError('unauthorized', `Neplatný API klíč ${label}.`, opts(false));
  if (s === 403) return new TrailPackError('forbidden', `Přístup ke službě ${label} byl odepřen${suffix}`, opts(false));
  if (s === 404) return new TrailPackError('not_found', `Model nebo endpoint služby ${label} nebyl nalezen${suffix}`, opts(false));
  if (s === 408) return new TrailPackError('timeout', `Služba ${label} nestihla požadavek zpracovat.`, opts(true));
  if (s === 413) return new TrailPackError('too_large', `Požadavek je pro službu ${label} příliš velký (zkuste menší obrázek nebo kratší konverzaci).`, opts(false));
  if (s === 429) {
    const wait = failure.retryAfterMs !== undefined ? ` Zkuste to znovu za ${Math.max(1, Math.ceil(failure.retryAfterMs / 1000))} s.` : ' Zkuste to prosím za chvíli.';
    return new TrailPackError('rate_limited', `Překročen limit požadavků služby ${label}.${wait}`, opts(true));
  }
  if (s === 529) return new TrailPackError('provider_error', `Služba ${label} je momentálně přetížená. Zkuste to prosím za chvíli.`, opts(true));
  if (s >= 500) return new TrailPackError('provider_error', `Chyba služby ${label} (HTTP ${s}). Zkuste to prosím později.`, opts(true));
  if (s === 409) return new TrailPackError('conflict', `Služba ${label} hlásí konflikt${suffix}`, opts(true));
  return new TrailPackError('invalid_input', `${label} odmítl požadavek${suffix}`, opts(false));
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Truncate without splitting a UTF-16 surrogate pair. */
export function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, max);
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${s.slice(0, end)}…`;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Join a base URL and a path without doubling slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Short random id for synthetic tool call ids (not security relevant). */
export function randomId(prefix: string): string {
  const rnd = () => Math.random().toString(36).slice(2, 10);
  return `${prefix}${rnd()}${rnd()}`;
}
