import { createLogAnalyticsClient, tablesToRows } from '@adminforge/connectors';
import { fakeFetch, jsonBody, type Fake } from './fake-fetch';

const WS = '00000000-0000-4000-8000-0000000000c1';
const client = (responses: Fake[]) => {
  const f = fakeFetch(responses);
  return { f, la: createLogAnalyticsClient({ getToken: async () => 'la-tok', fetch: f.fetch, sleep: async () => {}, correlationId: 'c-1' }) };
};
const TABLE = {
  name: 'PrimaryResult',
  columns: [
    { name: 'TimeGenerated', type: 'datetime' },
    { name: 'AppRoleName', type: 'string' },
    { name: 'Failures', type: 'long' },
    { name: 'Success', type: 'bool' },
    { name: 'Details', type: 'dynamic' },
  ],
  rows: [['2026-01-10T00:00:00Z', 'func-example', 3, false, '{"op":"sync"}']],
};

describe('log analytics client', () => {
  it('POSTs the query and timespan to the workspace', async () => {
    const { la, f } = client([{ status: 200, body: { tables: [TABLE] } }]);
    await la.query({ workspace: WS, query: 'AppRequests | take 1', timespan: 'P1D' });
    expect(f.calls[0]!.url).toBe(`https://api.loganalytics.io/v1/workspaces/${WS}/query`);
    expect(jsonBody(f.calls[0]!)).toEqual({ query: 'AppRequests | take 1', timespan: 'P1D' });
    expect((f.calls[0]!.init.headers as Record<string, string>)['x-ms-client-request-id']).toBe('c-1');
  });
  it('converts tables to typed row objects', async () => {
    const { la } = client([{ status: 200, body: { tables: [TABLE, { name: 'Stats', columns: [{ name: 'n', type: 'int' }], rows: [['5']] }] } }]);
    const r = await la.query({ workspace: WS, query: 'x' });
    expect(r.rows).toEqual([{ TimeGenerated: '2026-01-10T00:00:00Z', AppRoleName: 'func-example', Failures: 3, Success: false, Details: { op: 'sync' } }]);
    expect(r.tables.map((t) => t.name)).toEqual(['PrimaryResult', 'Stats']);
    expect(r.tables[1]!.rows).toEqual([{ n: 5 }]);
    expect(r.partialError).toBeUndefined();
  });
  it('surfaces partial errors next to the data', async () => {
    const { la } = client([{ status: 200, body: { tables: [TABLE], error: { code: 'PartialError', message: 'Some workspaces were unavailable.' } } }]);
    expect((await la.query({ workspace: WS, query: 'x' })).partialError).toEqual({ code: 'PartialError', message: 'Some workspaces were unavailable.' });
  });
  it('maps query errors', async () => {
    const { la } = client([{ status: 400, body: { error: { code: 'BadArgumentError', message: 'The request had some invalid properties' } } }]);
    await expect(la.query({ workspace: WS, query: 'bad |' })).rejects.toMatchObject({ status: 400, code: 'BadArgumentError' });
  });
  it('validates the workspace id and query', async () => {
    const { la } = client([]);
    await expect(la.query({ workspace: 'my-workspace', query: 'x' })).rejects.toThrow(/workspace id/);
    await expect(la.query({ workspace: WS, query: '' })).rejects.toThrow(/empty/);
  });
  it('converts string-typed values', () =>
    expect(tablesToRows([{ columns: [{ name: 'b', type: 'bool' }, { name: 'r', type: 'real' }, { name: 'd', type: 'dynamic' }], rows: [['True', '1.5', 'plain']] }])[0]!.rows).toEqual([
      { b: true, r: 1.5, d: 'plain' },
    ]));
});
