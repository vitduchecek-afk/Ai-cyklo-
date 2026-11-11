import { readFileSync } from 'node:fs';
import { HttpClient } from '@trailpack/shared';
import type { FetchLike } from '@trailpack/shared';

export const fixtureText = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
export const fixture = <T = any>(name: string): T => JSON.parse(fixtureText(name)) as T;  

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type Handler = (call: RecordedCall) => Response | Promise<Response> | undefined;

export const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** HttpClient backed by a mock fetch (no retries, no throttling); the first handler returning a Response wins. */
export function mockHttp(...handlers: Handler[]): { http: HttpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call: RecordedCall = { url: input, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === 'string' ? init.body : undefined };
    calls.push(call);
    for (const h of handlers) {
      const r = await h(call);
      if (r) return r;
    }
    return new Response('no mock', { status: 599 });
  };
  return { http: new HttpClient({ fetch, minIntervalMsPerHost: {}, retries: 0 }), calls };
}

/** Decodes the Overpass QL sent as `data=` form body. */
export const overpassQl = (call: RecordedCall): string => decodeURIComponent((call.body ?? '').replace(/^data=/, ''));
