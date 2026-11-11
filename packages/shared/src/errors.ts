/**
 * Centralised error model. Every adapter (routing, weather, AI, …) converts
 * low-level failures into a `TrailPackError` so the UI can show a meaningful,
 * localised message and decide whether a retry makes sense.
 */
export type ErrorCode =
  | 'network'
  | 'offline'
  | 'timeout'
  | 'aborted'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'not_configured'
  | 'invalid_input'
  | 'not_found'
  | 'no_route'
  | 'provider_error'
  | 'parse_error'
  | 'too_large'
  | 'storage_full'
  | 'permission_denied'
  | 'conflict'
  | 'unsupported'
  | 'budget_exceeded'
  | 'unknown';

export interface TrailPackErrorOptions {
  provider?: string;
  status?: number;
  retryable?: boolean;
  details?: unknown;
  cause?: unknown;
}

export class TrailPackError extends Error {
  readonly code: ErrorCode;
  readonly provider?: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, options: TrailPackErrorOptions = {}) {
    super(message);
    this.name = 'TrailPackError';
    this.code = code;
    this.provider = options.provider;
    this.status = options.status;
    this.details = options.details;
    this.retryable =
      options.retryable ?? (code === 'network' || code === 'timeout' || code === 'rate_limited' || code === 'offline');
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      provider: this.provider,
      status: this.status,
      retryable: this.retryable,
    };
  }
}

export const isTrailPackError = (e: unknown): e is TrailPackError => e instanceof TrailPackError;

/** Normalise any thrown value into a TrailPackError. */
export function toTrailPackError(e: unknown, provider?: string): TrailPackError {
  if (e instanceof TrailPackError) return e;
  if (e && typeof e === 'object' && 'name' in e) {
    const name = String((e as { name: unknown }).name);
    if (name === 'AbortError') return new TrailPackError('aborted', 'Request aborted', { provider, cause: e });
    if (name === 'TimeoutError') return new TrailPackError('timeout', 'Request timed out', { provider, cause: e });
    if (name === 'ZodError') {
      return new TrailPackError('invalid_input', 'Validation failed', { provider, details: (e as { issues?: unknown }).issues, cause: e });
    }
  }
  const message = e instanceof Error ? e.message : String(e);
  if (/network|fetch failed|Failed to fetch|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return new TrailPackError('network', message, { provider, cause: e });
  }
  return new TrailPackError('unknown', message, { provider, cause: e });
}

/** Map an HTTP status to an error code. */
export function errorCodeForStatus(status: number): ErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'invalid_input';
  return 'provider_error';
}

export type Result<T, E = TrailPackError> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export async function tryAsync<T>(fn: () => Promise<T>, provider?: string): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(toTrailPackError(e, provider));
  }
}
