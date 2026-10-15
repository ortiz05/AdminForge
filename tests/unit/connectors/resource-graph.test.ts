import { createResourceGraphClient, resourceGraphRows } from '@adminforge/connectors';
import { fakeFetch, jsonBody, type Fake } from './fake-fetch';

const client = (responses: Fake[]) => {
  const f = fakeFetch(responses);
  return {
    f,
    rg: createResourceGraphClient({ getToken: async () => 'tok', fetch: f.fetch, sleep: async () => {} }),
  };
};
const SUBS = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2'];

describe('resource graph client', () => {
  it('POSTs the query with subscriptions and objectArray results', async () => {
    const { rg, f } = client([
      {
        status: 200,
        body: { totalRecords: 1, count: 1, data: [{ name: 'vm-1' }], resultTruncated: 'false' },
      },
    ]);
    const page = await rg.query({ query: 'resources | project name', subscriptions: SUBS, top: 5000 });
    expect(f.calls[0]!.url).toBe(
      'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01',
    );
    expect(f.calls[0]!.init.method).toBe('POST');
    expect(jsonBody(f.calls[0]!)).toEqual({
      query: 'resources | project name',
      subscriptions: SUBS,
      options: { resultFormat: 'objectArray', $top: 1000 },
    });
    expect(page).toMatchObject({
      rows: [{ name: 'vm-1' }],
      totalRecords: 1,
      resultTruncated: false,
      skipToken: undefined,
    });
  });
  it('scopes to management groups', async () => {
    const { rg, f } = client([{ status: 200, body: { data: [] } }]);
    await rg.query({ query: 'resourcecontainers', managementGroups: ['mg-example'] });
    expect(jsonBody(f.calls[0]!)).toMatchObject({ managementGroups: ['mg-example'] });
    expect(jsonBody(f.calls[0]!)).not.toHaveProperty('subscriptions');
  });
  it('follows $skipToken across pages', async () => {
    const { rg, f } = client([
      { status: 200, body: { totalRecords: 3, data: [{ n: 1 }, { n: 2 }], $skipToken: 'tok-2' } },
      { status: 200, body: { totalRecords: 3, data: [{ n: 3 }] } },
    ]);
    expect(await rg.all({ query: 'resources' })).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(jsonBody<{ options: Record<string, unknown> }>(f.calls[1]!).options).toEqual({
      resultFormat: 'objectArray',
      $skipToken: 'tok-2',
    });
  });
  it('stops at maxItems', async () => {
    const { rg, f } = client([{ status: 200, body: { data: [{ n: 1 }, { n: 2 }], $skipToken: 'more' } }]);
    expect(await rg.all({ query: 'resources' }, 1)).toEqual([{ n: 1 }]);
    expect(f.calls).toHaveLength(1);
  });
  it('converts the table result format to rows', () =>
    expect(
      resourceGraphRows({
        columns: [{ name: 'name' }, { name: 'location' }],
        rows: [['vm-1', 'westeurope']],
      }),
    ).toEqual([{ name: 'vm-1', location: 'westeurope' }]));
  it('rejects empty queries', async () => {
    const { rg } = client([]);
    await expect(rg.query({ query: '  ' })).rejects.toThrow(/empty/);
  });
  it('retries throttled queries (POST is a read)', async () => {
    const { rg, f } = client([{ status: 500 }, { status: 200, body: { data: [{ n: 1 }] } }]);
    expect((await rg.query({ query: 'resources' })).rows).toEqual([{ n: 1 }]);
    expect(f.calls).toHaveLength(2);
  });
});
