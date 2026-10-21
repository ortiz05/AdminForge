import { ApiError, buildArmUrl, createArmClient } from '@adminforge/connectors';
import { fakeFetch, headersOf, type Fake } from './fake-fetch';

const ARM = 'https://management.azure.com';
const client = (responses: Fake[], extra = {}) => {
  const f = fakeFetch(responses);
  const sleep = vi.fn(async () => {});
  return {
    f,
    sleep,
    arm: createArmClient({
      getToken: async () => 'arm-tok',
      fetch: f.fetch,
      sleep,
      correlationId: 'corr-arm',
      pollIntervalMs: 1000,
      ...extra,
    }),
  };
};
const SUB = '/subscriptions/00000000-0000-4000-8000-0000000000a1';

describe('buildArmUrl', () => {
  it('requires api-version', () =>
    expect(() => buildArmUrl(ARM, { path: '/subscriptions', apiVersion: '' })).toThrow(/api-version/));
  it('puts api-version first and keeps other query values', () =>
    expect(
      buildArmUrl(ARM, {
        path: `${SUB}/resourceGroups`,
        apiVersion: '2021-04-01',
        query: { $filter: "tagName eq 'env'", $top: 10 },
      }),
    ).toBe(`${ARM}${SUB}/resourceGroups?api-version=2021-04-01&$filter=tagName%20eq%20'env'&$top=10`));
  it('lets apiVersion win over a query api-version', () =>
    expect(
      buildArmUrl(ARM, {
        path: '/subscriptions',
        apiVersion: '2022-12-01',
        query: { 'api-version': '1999-01-01' },
      }),
    ).toBe(`${ARM}/subscriptions?api-version=2022-12-01`));
  it('rejects traversal', () =>
    expect(() => buildArmUrl(ARM, { path: `${SUB}/../x`, apiVersion: '2022-12-01' })).toThrow(
      /Invalid ARM path/,
    ));
});

describe('arm client', () => {
  it('sends the token and x-ms-client-request-id, and returns x-ms-request-id', async () => {
    const { arm, f } = client([
      { status: 200, body: { id: SUB }, headers: { 'x-ms-request-id': 'arm-req-1' } },
    ]);
    const r = await arm.request({ path: SUB, apiVersion: '2022-12-01' });
    expect(r).toMatchObject({ data: { id: SUB }, status: 200, requestId: 'arm-req-1' });
    expect(headersOf(f.calls[0]!)).toMatchObject({
      Authorization: 'Bearer arm-tok',
      'x-ms-client-request-id': 'corr-arm',
    });
  });
  it('follows nextLink and refuses links outside ARM', async () => {
    const { arm } = client([
      {
        status: 200,
        body: { value: [{ n: 1 }], nextLink: `${ARM}/subscriptions?api-version=2022-12-01&$skiptoken=p2` },
      },
      { status: 200, body: { value: [{ n: 2 }], nextLink: 'https://management.azure.com.evil.example/x' } },
    ]);
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const page of arm.pages({ path: '/subscriptions', apiVersion: '2022-12-01' }))
          seen.push(...page);
      })(),
    ).rejects.toThrow(/outside Azure Resource Manager/);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });
  it('collects all pages', async () => {
    const { arm } = client([
      {
        status: 200,
        body: { value: [1, 2], nextLink: `${ARM}/subscriptions?api-version=2022-12-01&$skiptoken=p2` },
      },
      { status: 200, body: { value: [3] } },
    ]);
    expect(await arm.all({ path: '/subscriptions', apiVersion: '2022-12-01' })).toEqual([1, 2, 3]);
  });
  it('maps ARM errors', async () => {
    const { arm } = client([
      {
        status: 403,
        body: { error: { code: 'AuthorizationFailed', message: 'No access' } },
        headers: { 'x-ms-request-id': 'r9' },
      },
    ]);
    await expect(arm.request({ path: SUB, apiVersion: '2022-12-01' })).rejects.toMatchObject({
      status: 403,
      code: 'AuthorizationFailed',
      requestId: 'r9',
    });
  });

  describe('long-running operations', () => {
    const site = `${SUB}/resourceGroups/rg-example/providers/Microsoft.Web/sites/func-example`;
    it('polls Azure-AsyncOperation then GETs the resource for PUT', async () => {
      // The middle of the ±20 % Retry-After spread (D-03a): the wait is exactly what Microsoft named.
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      onTestFinished(() => random.mockRestore());
      const op = `${ARM}${SUB}/providers/Microsoft.Web/operations/op1?api-version=2022-03-01`;
      const { arm, f, sleep } = client([
        {
          status: 201,
          body: { properties: { provisioningState: 'Creating' } },
          headers: { 'azure-asyncoperation': op, 'retry-after': '7' },
        },
        { status: 200, body: { status: 'InProgress' } },
        { status: 200, body: { status: 'Succeeded' } },
        { status: 200, body: { id: site, properties: { provisioningState: 'Succeeded' } } },
      ]);
      const r = await arm.requestAndWait({
        method: 'PUT',
        path: site,
        apiVersion: '2022-03-01',
        body: { location: 'westeurope' },
      });
      expect(r.data).toEqual({ id: site, properties: { provisioningState: 'Succeeded' } });
      expect(f.calls.map((c) => [c.init.method, c.url])).toEqual([
        ['PUT', `${ARM}${site}?api-version=2022-03-01`],
        ['GET', op],
        ['GET', op],
        ['GET', `${ARM}${site}?api-version=2022-03-01`],
      ]);
      expect(sleep).toHaveBeenNthCalledWith(1, 7000);
      expect(sleep).toHaveBeenNthCalledWith(2, 1000);
    });
    it('polls Location until it stops answering 202 (POST)', async () => {
      const loc = `${ARM}${SUB}/providers/Microsoft.Web/locations/westeurope/operationResults/abc?api-version=2022-03-01`;
      const { arm, f } = client([
        { status: 202, headers: { location: loc } },
        { status: 202, headers: { location: loc } },
        { status: 200, body: { result: 'restarted' } },
      ]);
      const r = await arm.requestAndWait({
        method: 'POST',
        path: `${site}/restart`,
        apiVersion: '2022-03-01',
      });
      expect(r).toMatchObject({ status: 200, data: { result: 'restarted' } });
      expect(f.calls).toHaveLength(3);
    });
    it('throws the operation error when it fails', async () => {
      const op = `${ARM}${SUB}/operations/op2`;
      const { arm } = client([
        { status: 202, headers: { 'azure-asyncoperation': op } },
        {
          status: 200,
          body: { status: 'Failed', error: { code: 'Conflict', message: 'The site is busy.' } },
        },
      ]);
      const err = await arm
        .requestAndWait({ method: 'DELETE', path: site, apiVersion: '2022-03-01' })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ code: 'Conflict', message: 'The site is busy.' });
    });
    it('refuses polling URLs outside ARM', async () => {
      const { arm } = client([
        { status: 202, headers: { 'azure-asyncoperation': 'https://evil.example/op' } },
      ]);
      await expect(
        arm.requestAndWait({ method: 'DELETE', path: site, apiVersion: '2022-03-01' }),
      ).rejects.toThrow(/outside Azure Resource Manager/);
    });
    it('polls provisioningState for a 201 PUT without operation headers', async () => {
      const { arm } = client([
        { status: 201, body: { properties: { provisioningState: 'Accepted' } } },
        { status: 200, body: { properties: { provisioningState: 'Updating' } } },
        { status: 200, body: { properties: { provisioningState: 'Succeeded' } } },
      ]);
      await expect(
        arm.requestAndWait({ method: 'PUT', path: site, apiVersion: '2022-03-01', body: {} }),
      ).resolves.toMatchObject({
        data: { properties: { provisioningState: 'Succeeded' } },
      });
    });
    it('gives up after maxPollMs', async () => {
      const op = `${ARM}${SUB}/operations/op3`;
      const { arm } = client([{ status: 202, headers: { 'azure-asyncoperation': op } }], { maxPollMs: -1 });
      await expect(
        arm.requestAndWait({ method: 'DELETE', path: site, apiVersion: '2022-03-01' }),
      ).rejects.toMatchObject({ code: 'OperationTimedOut' });
    });
    it('returns non-LRO responses unchanged', async () => {
      const { arm, f } = client([{ status: 200, body: { ok: true } }]);
      await expect(
        arm.requestAndWait({ method: 'PATCH', path: site, apiVersion: '2022-03-01', body: {} }),
      ).resolves.toMatchObject({ data: { ok: true } });
      expect(f.calls).toHaveLength(1);
    });
  });
});
