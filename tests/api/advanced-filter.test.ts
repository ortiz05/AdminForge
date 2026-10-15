import { ApiErrorBody, DatasourceResult } from '@adminforge/schemas';
import { json, liveApp, setupContent, TEST_USERS, type ContentEnv } from './content-helpers';

let env: ContentEnv;
beforeAll(() => {
  env = setupContent();
});
afterAll(() => env.cleanup());

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

describe('query builder filters through the datasource executor', () => {
  it('Graph: the structured filter is validated and compiled into $filter; the raw value never reaches templates', async () => {
    const t = await liveApp(env, () => json({ value: TEST_USERS }));
    const h = { cookie: t.cookie, 'x-adminforge-csrf': t.csrf };
    const exec = (params: Record<string, unknown>) => t.app.inject({ method: 'POST', url: '/api/datasources/execute', headers: h, payload: { page: 'identity.users', datasource: 'users', params } });
    const lastFilter = () => new URL(t.calls.at(-1)!.url).searchParams.get('$filter');

    const adv = { all: [{ field: 'department', op: 'eq', value: "O'Brien" }, { any: [{ field: 'accountEnabled', op: 'eq', value: false }, { field: 'created', op: 'ge', value: '2026-01-01' }] }] };
    expect((await exec({ userType: 'Member', adv })).statusCode).toBe(200);
    expect(lastFilter()).toBe("userType eq 'Member' and (department eq 'O''Brien' and (accountEnabled eq false or createdDateTime ge 2026-01-01T00:00:00.000Z))");

    // URL form (base64url JSON) behaves the same; mapped properties are used.
    expect((await exec({ adv: b64({ any: [{ field: 'manager', op: 'eq', value: '00000000-0000-4000-8000-0000000000AB' }] }) })).statusCode).toBe(200);
    expect(lastFilter()).toBe("manager/id eq '00000000-0000-4000-8000-0000000000ab'");

    // Injection in a value stays a quoted literal.
    expect((await exec({ adv: { all: [{ field: 'department', op: 'eq', value: "') or true or ('" }] } })).statusCode).toBe(200);
    expect(lastFilter()).toBe("department eq ''') or true or ('''");
    await t.app.close();
  });

  it('rejects raw OData, unknown fields, wrong types and operators with 400 before calling Microsoft', async () => {
    const t = await liveApp(env, () => json({ value: [] }));
    const h = { cookie: t.cookie, 'x-adminforge-csrf': t.csrf };
    const before = t.calls.length;
    const cases: Array<[unknown, RegExp]> = [
      ["accountEnabled eq true or userType eq 'Guest'", /must be the query builder filter/],
      [{ all: [{ field: 'userPrincipalName', op: 'eq', value: 'x' }] }, /unknown field/],
      [{ all: [{ field: 'accountEnabled', op: 'eq', value: 'true) or (1 eq 1' }] }, /expects true or false/],
      [{ all: [{ field: 'department', op: 'gt', value: 'a' }] }, /does not support "gt"/],
      [{ all: [{ field: 'userType', op: 'eq', value: 'Admin' }] }, /expects one of Member, Guest/],
      [{ all: [{ field: 'department', op: 'eq', value: 'x' }], $filter: '1 eq 1' }, /not a valid filter/],
    ];
    for (const [adv, pattern] of cases) {
      const res = await t.app.inject({ method: 'POST', url: '/api/datasources/execute', headers: h, payload: { page: 'identity.users', datasource: 'users', params: { adv } } });
      expect(res.statusCode).toBe(400);
      const err = ApiErrorBody.parse(res.json()).error;
      expect(err.code).toBe('invalid_params');
      expect(err.message).toMatch(pattern);
    }
    expect(t.calls.length).toBe(before);
    await t.app.close();
  });

  it('Resource Graph: compiled to a KQL predicate; pipes and quotes in values stay inside the literal', async () => {
    const t = await liveApp(env, () => json({ totalRecords: 0, data: [] }));
    const h = { cookie: t.cookie, 'x-adminforge-csrf': t.csrf };
    const run = async (adv: unknown) => {
      const res = await t.app.inject({ method: 'POST', url: '/api/datasources/execute', headers: h, payload: { page: 'deps.inventory', datasource: 'inv', params: { adv } } });
      return { res, query: (t.calls.at(-1)!.body as { query: string }).query };
    };
    const a = await run({ all: [{ field: 'name', op: 'startsWith', value: 'func-' }, { field: 'tagCount', op: 'gt', value: 0 }, { field: 'state', op: 'eq', value: 'Succeeded' }] });
    expect(a.res.statusCode).toBe(200);
    expect(a.query).toBe("Resources\n| where (name startswith 'func-' and tagCount > 0 and properties.provisioningState =~ 'Succeeded')\n| project id, name");
    const b = await run({ all: [{ field: 'name', op: 'eq', value: "x' | take 1 | project secret //" }] });
    expect(b.query).toBe("Resources\n| where name =~ 'x\\' | take 1 | project secret //'\n| project id, name");
    const none = await run(undefined);
    expect(none.query).toBe('Resources\n\n| project id, name');
    expect((await run({ all: [{ field: 'tagCount', op: 'gt', value: '0 | take 1' }] })).res.statusCode).toBe(400);
    await t.app.close();
  });

  it('exports use the same compiled filter, and the audit records it in wire form', async () => {
    const t = await liveApp(env, () => json({ value: TEST_USERS.slice(0, 1) }));
    const adv = { all: [{ field: 'department', op: 'startsWith', value: 'IT' }] };
    const res = await t.app.inject({ method: 'POST', url: '/api/reports/identity.users/export', headers: { cookie: t.cookie, 'x-adminforge-csrf': t.csrf }, payload: { format: 'csv', params: { adv } } });
    expect(res.statusCode).toBe(200);
    expect(new URL(t.calls.at(-1)!.url).searchParams.get('$filter')).toBe("startswith(department, 'IT')");
    await new Promise((r) => setTimeout(r, 20));
    expect(t.audit.rows.find((r) => r.action === 'report.exported')!.details).toMatchObject({ params: { adv } });
    await t.app.close();
  });

  it('pages without a query builder treat the param as unknown', async () => {
    const t = await liveApp(env, () => json({ value: [] }));
    const res = await t.app.inject({ method: 'POST', url: '/api/datasources/execute', headers: { cookie: t.cookie, 'x-adminforge-csrf': t.csrf }, payload: { page: 'identity.expiry', datasource: 'creds', params: { adv: { all: [] } } } });
    expect(res.statusCode).toBe(400);
    expect(ApiErrorBody.parse(res.json()).error.message).toMatch(/adv: unknown parameter/);
    expect(DatasourceResult.safeParse(res.json()).success).toBe(false);
    await t.app.close();
  });
});
