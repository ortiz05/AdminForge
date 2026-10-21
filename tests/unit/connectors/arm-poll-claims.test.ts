import {
  AcceptedUnconfirmedError,
  ApiError,
  createArmClient,
  createGraphClient,
} from '@adminforge/connectors';
import { fakeFetch } from './fake-fetch';

// A Continuous Access Evaluation claims challenge (401 with `claims`) makes the API's token broker run the whole call
// again with a new token. After Microsoft accepted a change — on a long-running operation's poll, or a `$batch` chunk
// after one was processed — that would send the change a second time, so such a challenge becomes an
// AcceptedUnconfirmedError: the step fails, saying the change was accepted and not sent again (security review of the
// platform-review fixes). A challenge on the first request (nothing processed) keeps its claims.

const SESSION =
  '/subscriptions/00000000-0000-4000-8000-0000000000a1/resourceGroups/rg/providers/Microsoft.DesktopVirtualization/hostPools/hp/sessionHosts/h/userSessions/3';
const CHALLENGE = {
  status: 401,
  body: { error: { code: 'InvalidAuthenticationToken', message: 'Claims challenge.' } },
  headers: {
    'www-authenticate': 'Bearer error="insufficient_claims", claims="eyJhY2Nlc3NfdG9rZW4iOnt9fQ=="',
  },
};

const client = (responses: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(responses);
  return {
    f,
    arm: createArmClient({
      getToken: async () => 'tok',
      fetch: f.fetch,
      sleep: async () => {},
      pollIntervalMs: 1,
    }),
  };
};
const logOff = { method: 'DELETE', path: SESSION, apiVersion: '2024-04-03' };

describe('ARM long-running operations and claims challenges', () => {
  it('a poll answered with a claims challenge fails without the challenge', async () => {
    const { f, arm } = client([
      { status: 202, headers: { location: 'https://management.azure.com/operations/op-1' } },
      CHALLENGE,
    ]);
    const err = await arm.requestAndWait(logOff).catch((e: unknown) => e);
    // Not an ApiError: nothing answers it by sending the whole call again; not transient: no retry policy does.
    expect(err).toBeInstanceOf(AcceptedUnconfirmedError);
    expect(err).not.toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 'accepted_unconfirmed',
      message: expect.stringMatching(/^Azure accepted/),
    });
    expect(f.calls.map((c) => c.init.method)).toEqual(['DELETE', 'GET']);
  });

  it('so does the Azure-AsyncOperation poll and the final read of the resource', async () => {
    const op = { 'azure-asyncoperation': 'https://management.azure.com/operations/op-2' };
    const polled = client([{ status: 201, headers: op }, CHALLENGE]);
    expect(
      await polled.arm.requestAndWait({ ...logOff, method: 'PUT', body: {} }).catch((e) => e),
    ).toBeInstanceOf(AcceptedUnconfirmedError);
    const final = client([
      { status: 202, headers: op },
      { status: 200, body: { status: 'Succeeded' } },
      CHALLENGE,
    ]);
    expect(
      await final.arm.requestAndWait({ ...logOff, method: 'PATCH', body: {} }).catch((e) => e),
    ).toBeInstanceOf(AcceptedUnconfirmedError);
  });

  it('a challenge on the request itself keeps its claims (it was not processed: the broker may send it again)', async () => {
    const { arm } = client([CHALLENGE]);
    const err = (await arm.requestAndWait(logOff).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.claims).toBe('eyJhY2Nlc3NfdG9rZW4iOnt9fQ==');
  });
});

describe('Graph $batch chunks and claims challenges', () => {
  const ITEMS = Array.from({ length: 25 }, (_, i) => ({
    id: String(i + 1),
    method: 'DELETE',
    path: `/groups/g/members/${i + 1}/$ref`,
  }));
  const answered = (from: number, to: number) => ({
    status: 200,
    body: {
      responses: Array.from({ length: to - from + 1 }, (_, i) => ({ id: String(from + i), status: 204 })),
    },
  });

  it('a later chunk’s challenge, once a chunk was processed, fails without the challenge', async () => {
    const f = fakeFetch([answered(1, 20), CHALLENGE]);
    const graph = createGraphClient({ getToken: async () => 'tok', fetch: f.fetch, sleep: async () => {} });
    const err = await graph.batch(ITEMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcceptedUnconfirmedError);
    expect(f.calls).toHaveLength(2);
  });

  it('the first chunk’s challenge keeps its claims (nothing was processed yet)', async () => {
    const f = fakeFetch([CHALLENGE]);
    const graph = createGraphClient({ getToken: async () => 'tok', fetch: f.fetch, sleep: async () => {} });
    expect(await graph.batch(ITEMS).catch((e: unknown) => e)).toMatchObject({
      status: 401,
      claims: expect.any(String),
    });
  });
});
