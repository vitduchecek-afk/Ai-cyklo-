import { TrailPackError, errorCodeForStatus, toTrailPackError } from '@trailpack/shared';
import type { z } from 'zod';
import {
  DeviceAuthResponseSchema,
  PullResponseSchema,
  PushResponseSchema,
  type DeviceAuthResponse,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type SyncTransport,
} from './protocol';

export interface HttpSyncTransportOptions {
  /** API origin, e.g. `https://api.example.com` (a trailing slash is ignored). */
  baseUrl: string;
  /** Bearer token provider; return null when the device is not registered yet. */
  getToken: () => string | null | Promise<string | null>;
  fetch?: typeof fetch;
  /** Per request timeout (default 30 s). */
  timeoutMs?: number;
}

function joinSignals(external: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; done(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

async function requestJson<S extends z.ZodType>(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  schema: S,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  const joined = joinSignals(signal, timeoutMs);
  try {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: joined.signal });
    } catch (e) {
      const reason = joined.signal.reason as { name?: string } | undefined;
      if (reason?.name === 'TimeoutError') throw new TrailPackError('timeout', 'Sync request timed out', { cause: e });
      throw toTrailPackError(e, 'sync');
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const err = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new TrailPackError(errorCodeForStatus(res.status), err?.message ?? `Server responded with HTTP ${res.status}`, {
        provider: 'sync',
        status: res.status,
        retryable: res.status >= 500 || res.status === 429 || res.status === 408,
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new TrailPackError('parse_error', 'Unexpected response from sync server', { provider: 'sync', details: parsed.error.issues });
    return parsed.data;
  } finally {
    joined.done();
  }
}

/** `SyncTransport` talking to the TrailPack API over HTTPS. */
export class HttpSyncTransport implements SyncTransport {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpSyncTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  private async headers(json: boolean): Promise<Record<string, string>> {
    const token = await this.options.getToken();
    if (!token) throw new TrailPackError('unauthorized', 'Zařízení není přihlášeno k synchronizaci.');
    return { authorization: `Bearer ${token}`, accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) };
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetch ?? fetch;
  }

  async push(request: PushRequest, signal?: AbortSignal): Promise<PushResponse> {
    return requestJson(
      this.fetchImpl,
      `${this.baseUrl}/v1/sync/push`,
      { method: 'POST', headers: await this.headers(true), body: JSON.stringify(request) },
      PushResponseSchema,
      this.timeoutMs,
      signal,
    );
  }

  async pull(query: { cursor: string; limit?: number; deviceId?: string }, signal?: AbortSignal): Promise<PullResponse> {
    const params = new URLSearchParams({ cursor: query.cursor });
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.deviceId) params.set('deviceId', query.deviceId);
    return requestJson(
      this.fetchImpl,
      `${this.baseUrl}/v1/sync/pull?${params.toString()}`,
      { method: 'GET', headers: await this.headers(false) },
      PullResponseSchema,
      this.timeoutMs,
      signal,
    );
  }
}

/** Register this device with the server and obtain its bearer token. */
export async function registerDevice(options: { baseUrl: string; fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal }): Promise<DeviceAuthResponse> {
  return requestJson(
    options.fetch ?? fetch,
    `${options.baseUrl.replace(/\/+$/, '')}/v1/auth/device`,
    { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: '{}' },
    DeviceAuthResponseSchema,
    options.timeoutMs ?? 30000,
    options.signal,
  );
}
