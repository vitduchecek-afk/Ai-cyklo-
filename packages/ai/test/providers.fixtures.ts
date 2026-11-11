import type { FetchLike } from '@trailpack/shared';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

export type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; text?: string };

/** Scripted fetch: replies are consumed in order (the last one repeats). */
export function mockFetch(replies: Reply[]): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({ url, method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const r = replies[Math.min(i++, replies.length - 1)] as Reply;
    return new Response(r.text ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
  };
  return { fetch, calls };
}

export const FAST = { retries: 0, retryBaseDelayMs: 0 } as const;
