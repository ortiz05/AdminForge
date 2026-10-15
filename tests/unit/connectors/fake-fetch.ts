import { vi } from 'vitest';

export type Fake = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
export type Call = { url: string; init: RequestInit };

/** Scripted fetch: answers responses in order (500 when exhausted) and records every call. */
export function fakeFetch(responses: Fake[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 500 };
    if (r instanceof Error) throw r;
    const text = typeof r.body === 'string' || typeof r.body === 'number';
    return new Response(r.body === undefined ? null : text ? String(r.body) : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': text ? 'text/plain' : 'application/json', ...r.headers },
    });
  });
  return { fetch: fn as unknown as typeof fetch, calls, fn };
}

export const headersOf = (c: Call) => c.init.headers as Record<string, string>;
export const jsonBody = <T = Record<string, unknown>>(c: Call) => JSON.parse(String(c.init.body)) as T;
