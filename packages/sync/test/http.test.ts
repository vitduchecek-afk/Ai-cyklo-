import { describe, expect, it, vi } from 'vitest';
import { HttpSyncTransport, registerDevice } from '../src';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('HttpSyncTransport', () => {
  const change = { entity: 'trips' as const, id: 't1', op: 'upsert' as const, data: { id: 't1' }, updatedAt: '2026-01-01T00:00:00.000Z', deviceId: 'd1' };

  it('pushes with bearer auth and validates the response', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(200, { accepted: 1, rejected: [], cursor: '5' }));
    const t = new HttpSyncTransport({ baseUrl: 'https://api.test/', getToken: async () => 'tok', fetch: fetchMock as unknown as typeof fetch });
    const res = await t.push({ deviceId: 'd1', changes: [change] });
    expect(res).toEqual({ accepted: 1, rejected: [], cursor: '5' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.test/v1/sync/push');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(init!.body as string)).toMatchObject({ deviceId: 'd1' });
  });

  it('pulls with query parameters', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) => json(200, { changes: [{ ...change, serverSeq: 6 }], cursor: '6', hasMore: false }));
    const t = new HttpSyncTransport({ baseUrl: 'https://api.test', getToken: () => 'tok', fetch: fetchMock as unknown as typeof fetch });
    const res = await t.pull({ cursor: '5', limit: 10, deviceId: 'd1' });
    expect(res.changes[0]!.serverSeq).toBe(6);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.test/v1/sync/pull?cursor=5&limit=10&deviceId=d1');
  });

  it('maps HTTP errors to TrailPackError codes', async () => {
    const mk = (res: Response) => new HttpSyncTransport({ baseUrl: 'https://x', getToken: () => 't', fetch: (async () => res) as unknown as typeof fetch });
    await expect(mk(json(401, { error: { code: 'unauthorized', message: 'Neplatný token' } })).pull({ cursor: '0' })).rejects.toMatchObject({ code: 'unauthorized', message: 'Neplatný token', retryable: false });
    await expect(mk(json(429, {})).pull({ cursor: '0' })).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
    await expect(mk(json(503, {})).pull({ cursor: '0' })).rejects.toMatchObject({ code: 'provider_error', retryable: true });
    await expect(mk(json(200, { wrong: true })).pull({ cursor: '0' })).rejects.toMatchObject({ code: 'parse_error' });
    await expect(mk(new Response('<html>', { status: 200 })).pull({ cursor: '0' })).rejects.toMatchObject({ code: 'parse_error' });
  });

  it('requires a token and maps network failures and timeouts', async () => {
    const noToken = new HttpSyncTransport({ baseUrl: 'https://x', getToken: () => null, fetch: (async () => json(200, {})) as unknown as typeof fetch });
    await expect(noToken.pull({ cursor: '0' })).rejects.toMatchObject({ code: 'unauthorized' });
    const down = new HttpSyncTransport({ baseUrl: 'https://x', getToken: () => 't', fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
    await expect(down.pull({ cursor: '0' })).rejects.toMatchObject({ code: 'network' });
    const hang = new HttpSyncTransport({
      baseUrl: 'https://x',
      getToken: () => 't',
      timeoutMs: 20,
      fetch: ((_u: string, init: RequestInit) =>
        new Promise((_r, rej) => {
          if (init.signal!.aborted) rej(init.signal!.reason);
          init.signal!.addEventListener('abort', () => rej(init.signal!.reason));
        })) as unknown as typeof fetch,
    });
    await expect(hang.pull({ cursor: '0' })).rejects.toMatchObject({ code: 'timeout' });
    const ctrl = new AbortController();
    const p = hang.pull({ cursor: '0' }, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toBeDefined();
  });

  it('registers a device', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(200, { userId: 'u1', token: 'abc' }));
    expect(await registerDevice({ baseUrl: 'https://api.test/', fetch: fetchMock as unknown as typeof fetch })).toEqual({ userId: 'u1', token: 'abc' });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.test/v1/auth/device');
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('POST');
  });
});
