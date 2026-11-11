/**
 * Transport that talks to the TrailPack API server (`POST /v1/ai/chat`)
 * instead of a provider directly. The server holds the provider keys, enforces
 * budgets and returns a normalised {@link ChatResponse}.
 */
import { TrailPackError, errorCodeForStatus, type ErrorCode } from '@trailpack/shared';
import type { ChatRequest, ChatResponse, ChatTransport } from '../types';
import { assertChatRequest, badPayload, type DirectTransportOptions } from './common';
import { callJson, isRecord, joinUrl, resolveHttpOptions, truncateText, type HttpFailure, type ResolvedHttpOptions } from './http';

export interface ProxyTransportOptions extends DirectTransportOptions {
  /** e.g. `https://api.trailpack.app` */
  baseUrl: string;
  /** Returns the current user's access token (or null when signed out). */
  getToken: () => Promise<string | null | undefined> | string | null | undefined;
}

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'network', 'offline', 'timeout', 'aborted', 'unauthorized', 'forbidden', 'rate_limited', 'not_configured', 'invalid_input', 'not_found',
  'no_route', 'provider_error', 'parse_error', 'too_large', 'storage_full', 'permission_denied', 'conflict', 'unsupported', 'budget_exceeded', 'unknown',
]);

/** {@link ChatTransport} for the TrailPack API proxy. */
export class ProxyTransport implements ChatTransport {
  private readonly http: ResolvedHttpOptions;

  constructor(private readonly options: ProxyTransportOptions) {
    if (!options.baseUrl) throw new TrailPackError('not_configured', 'Chybí adresa serveru TrailPack.', { provider: 'proxy' });
    this.http = resolveHttpOptions(options);
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    assertChatRequest(request, 'proxy');
    const token = await this.options.getToken();
    if (!token) throw new TrailPackError('unauthorized', 'Pro použití asistenta se přihlaste k účtu TrailPack.', { provider: 'proxy', retryable: false });
    const { data } = await callJson<unknown>(this.http, {
      providerId: 'proxy',
      providerLabel: 'TrailPack',
      url: joinUrl(this.options.baseUrl, '/v1/ai/chat'),
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: request,
      signal,
      mapError: mapProxyError,
      secrets: [token],
    });
    if (!isRecord(data) || !isRecord(data.message) || !Array.isArray(data.message.parts) || !isRecord(data.usage)) {
      throw badPayload('proxy', 'TrailPack', 'neplatná odpověď serveru');
    }
    return data as unknown as ChatResponse;
  }
}

/** `{error:{code,message}}` → TrailPackError (falls back to the HTTP status). */
export function mapProxyError(failure: HttpFailure): TrailPackError {
  const body = isRecord(failure.body) && isRecord(failure.body.error) ? failure.body.error : undefined;
  const rawCode = typeof body?.code === 'string' ? body.code : undefined;
  const code: ErrorCode = rawCode && ERROR_CODES.has(rawCode) ? (rawCode as ErrorCode) : errorCodeForStatus(failure.status);
  const message =
    typeof body?.message === 'string' && body.message !== '' ? truncateText(body.message, 500) : `Server TrailPack vrátil chybu (HTTP ${failure.status}).`;
  const retryable = code === 'rate_limited' || code === 'timeout' || code === 'network' || (code === 'provider_error' && failure.status >= 500);
  return new TrailPackError(code, message, {
    provider: 'proxy',
    status: failure.status,
    retryable,
    details: { retryAfterMs: failure.retryAfterMs, details: body?.details },
  });
}
