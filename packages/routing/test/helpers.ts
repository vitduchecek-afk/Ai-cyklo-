import { readFileSync } from 'node:fs';
import { HttpClient } from '@trailpack/shared';
import type { FetchLike } from '@trailpack/shared';

export const fixture = <T = any>(name: string): T => // eslint-disable-line @typescript-eslint/no-explicit-any
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;

export const fixtureText = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export type Handler = (call: RecordedCall) => Response | Promise<Response> | undefined;

export const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** HttpClient backed by a mock fetch; the first handler returning a Response wins. */
export function mockHttp(...handlers: Handler[]): { http: HttpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const body = typeof init?.body === 'string' ? safeJson(init.body) : undefined;
    const call: RecordedCall = { url: input, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body };
    calls.push(call);
    for (const h of handlers) {
      const r = await h(call);
      if (r) return r;
    }
    return new Response('no mock', { status: 599 });
  };
  return { http: new HttpClient({ fetch, minIntervalMsPerHost: {}, retries: 0 }), calls };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
