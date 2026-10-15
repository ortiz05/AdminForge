import {
  RESPONSE_SIGNATURE_HEADER,
  RunnerEventSigner,
  openRunnerTokens,
  signRunnerResponse,
} from '@adminforge/runner';

/** One job request as a fake runner sees it: the parsed body, its timestamp, and the tokens it opened. */
export interface FakeRunnerRequest {
  url: string;
  redirect: RequestRedirect | undefined;
  rawBody: string;
  body: Record<string, unknown> & { jobId: string; nonce: string; sealedTokens?: string };
  timestamp: string;
  tokens: Record<string, string>;
}

/** Reads a job request sent through `fetch` the way the runner would (tokens opened with the shared key). */
export function readFakeRunnerRequest(
  key: string,
  input: unknown,
  init: RequestInit | undefined,
): FakeRunnerRequest {
  const rawBody = String(init?.body ?? '');
  const body = JSON.parse(rawBody) as FakeRunnerRequest['body'];
  const headers = new Headers(init?.headers);
  const timestamp = headers.get('x-adminforge-timestamp') ?? '';
  const tokens = body.sealedTokens
    ? (openRunnerTokens({ key, jobId: body.jobId, timestamp, sealed: body.sealedTokens }) as Record<
        string,
        string
      >)
    : {};
  return { url: String(input), redirect: init?.redirect, rawBody, body, timestamp, tokens };
}

/**
 * A 200 NDJSON answer signed for this request, as the runner sends it: `accepted` first, then the given events.
 * Pass `done` yourself (or leave it out to test an answer that ends early).
 */
export function signedRunnerAnswer(
  key: string,
  request: FakeRunnerRequest,
  events: Array<Record<string, unknown>>,
): Response {
  const signer = new RunnerEventSigner(key, request.body.jobId, request.body.nonce);
  const text = [{ type: 'accepted', jobId: request.body.jobId }, ...events]
    .map((e) => signer.line(e))
    .join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

/** A refusal (non-200 JSON) signed for this request, as the runner sends it. */
export function signedRunnerRefusal(
  key: string,
  request: FakeRunnerRequest,
  status: number,
  payload: Record<string, unknown>,
): Response {
  const text = JSON.stringify(payload);
  return new Response(text, {
    status,
    headers: {
      'content-type': 'application/json',
      [RESPONSE_SIGNATURE_HEADER]: signRunnerResponse({ key, nonce: request.body.nonce, status, body: text }),
    },
  });
}
