import { ApiError, createArmClient } from '@adminforge/connectors';
import { fakeFetch } from './fake-fetch';

// A Continuous Access Evaluation claims challenge (401 with `claims`) makes the API's token broker run the whole call
// again with a new token. On a long-running operation's poll — after Azure accepted the change — that would send the
// change a second time, so the poll's challenge is dropped: the step fails, saying the change was accepted (security
// review of the platform-review fixes). A challenge on the request itself (nothing processed) keeps its claims.

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
    const err = (await arm.requestAndWait(logOff).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, claims: undefined });
    expect(err.message).toMatch(/^Azure accepted the change/);
    expect(f.calls.map((c) => c.init.method)).toEqual(['DELETE', 'GET']);
  });

  it('so does the Azure-AsyncOperation poll and the final read of the resource', async () => {
    const op = { 'azure-asyncoperation': 'https://management.azure.com/operations/op-2' };
    const polled = client([{ status: 201, headers: op }, CHALLENGE]);
    expect(
      await polled.arm.requestAndWait({ ...logOff, method: 'PUT', body: {} }).catch((e) => e),
    ).toMatchObject({
      status: 401,
      claims: undefined,
    });
    const final = client([
      { status: 202, headers: op },
      { status: 200, body: { status: 'Succeeded' } },
      CHALLENGE,
    ]);
    expect(
      await final.arm.requestAndWait({ ...logOff, method: 'PATCH', body: {} }).catch((e) => e),
    ).toMatchObject({
      status: 401,
      claims: undefined,
    });
  });

  it('a challenge on the request itself keeps its claims (it was not processed: the broker may send it again)', async () => {
    const { arm } = client([CHALLENGE]);
    const err = (await arm.requestAndWait(logOff).catch((e: unknown) => e)) as ApiError;
    expect(err.claims).toBe('eyJhY2Nlc3NfdG9rZW4iOnt9fQ==');
  });
});
