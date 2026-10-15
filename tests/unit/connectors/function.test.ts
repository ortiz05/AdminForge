import { ApiError, createFunctionClient, evaluate, type FunctionConnection } from '@adminforge/connectors';
import { fakeFetch, headersOf, jsonBody, type Fake } from './fake-fetch';

const connection: FunctionConnection = {
  id: 'integrations.hr-sync',
  baseUrl: 'https://func-hr-sync.example.com/',
  operations: {
    listEmployees: { method: 'GET', path: '/api/employees', mode: 'read' },
    search: { method: 'POST', path: '/api/employees/search', mode: 'read', idempotent: true },
    syncEmployee: { method: 'POST', path: '/api/employees/{id}/sync', mode: 'write' },
  },
};
const client = (responses: Fake[], extra = {}) => {
  const f = fakeFetch(responses);
  const getToken = vi.fn(async () => 'fn-tok');
  return {
    f,
    getToken,
    fn: createFunctionClient({
      connection,
      getToken,
      fetch: f.fetch,
      sleep: async () => {},
      correlationId: 'corr-fn',
      ...extra,
    }),
  };
};

describe('function client', () => {
  it('calls an allowlisted operation with the connection token', async () => {
    const { fn, f, getToken } = client([{ status: 200, body: [{ id: 'e1' }] }]);
    const r = await fn.call('listEmployees', { query: { department: 'Finance & Ops' } });
    expect(r).toMatchObject({ data: [{ id: 'e1' }], status: 200, mode: 'read' });
    expect(f.calls[0]!.url).toBe(
      'https://func-hr-sync.example.com/api/employees?department=Finance%20%26%20Ops',
    );
    expect(headersOf(f.calls[0]!)).toMatchObject({
      Authorization: 'Bearer fn-tok',
      'x-ms-client-request-id': 'corr-fn',
    });
    expect(getToken).toHaveBeenCalled();
  });
  it('refuses operations outside the allowlist', async () => {
    const { fn } = client([]);
    await expect(fn.call('deleteEverything')).rejects.toThrow(/no operation "deleteEverything"/);
    await expect(fn.call('toString')).rejects.toThrow(/no operation/);
  });
  it('refuses write operations unless allowed', async () => {
    const { fn } = client([]);
    const err = await fn.call('syncEmployee', { pathParams: { id: 'e1' } }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: 'WriteNotAllowed' });
  });
  it('fills and encodes path parameters', async () => {
    const { fn, f } = client([{ status: 202 }], { allowWrite: true });
    await fn.call('syncEmployee', { pathParams: { id: 'a/b c' }, body: { force: true } });
    expect(f.calls[0]!.url).toBe('https://func-hr-sync.example.com/api/employees/a%2Fb%20c/sync');
    expect(jsonBody(f.calls[0]!)).toEqual({ force: true });
  });
  it('requires every path parameter and rejects dot segments', async () => {
    const { fn } = client([], { allowWrite: true });
    await expect(fn.call('syncEmployee')).rejects.toThrow(/needs path parameter "id"/);
    await expect(fn.call('syncEmployee', { pathParams: { id: '..' } })).rejects.toThrow(/Invalid value/);
  });
  it('resolves calls for policy checks', () => {
    const { fn } = client([]);
    const r = fn.resolve('search');
    expect(r).toEqual({
      method: 'POST',
      url: 'https://func-hr-sync.example.com/api/employees/search',
      path: '/api/employees/search',
      mode: 'read',
    });
    expect(
      evaluate('read', {
        service: 'function',
        method: r.method,
        path: r.path,
        declaredRead: r.mode === 'read',
      }).allowed,
    ).toBe(true);
  });
  it('retries read POSTs marked idempotent', async () => {
    const { fn, f } = client([{ status: 503 }, { status: 200, body: [] }]);
    await fn.call('search', { body: { q: 'x' } });
    expect(f.calls).toHaveLength(2);
  });
  it('requires an https base URL (http only for localhost)', () => {
    expect(() =>
      createFunctionClient({
        connection: { ...connection, baseUrl: 'http://func.example.com' },
        getToken: async () => 't',
      }),
    ).toThrow(/https/);
    expect(() =>
      createFunctionClient({
        connection: { ...connection, baseUrl: 'http://localhost:7071' },
        getToken: async () => 't',
      }),
    ).not.toThrow();
  });
});
