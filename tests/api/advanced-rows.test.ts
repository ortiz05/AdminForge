import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ApiErrorBody } from '@adminforge/schemas';
import { json, liveApp, setupContent, type ContentEnv } from './content-helpers';

// A list page over a source with no query language (static here; runner in real content): the query builder's
// filter is validated by the API and applied to the rows in the transform with $applyAdvanced(rows, advanced).
const MAILBOXES = `kind: page
id: deps.mailboxes
version: 1.0.0
title: Mailboxes
owner: t
template: list-detail
params:
  type: { type: enum, values: [All, UserMailbox, SharedMailbox], default: All, facet: true }
filters:
  advanced:
    dialect: rows
    fields:
      - { field: displayName, label: Name, type: string, operators: [startsWith, contains, eq] }
      - { field: created, label: Created, type: date, property: whenCreated, operators: [ge, le] }
      - { field: hold, label: Litigation hold, type: boolean, property: litigationHoldEnabled }
      - { field: owner, label: Owner, type: string, property: owner.displayName, operators: [eq] }
datasources:
  mailboxes:
    source: static
    data:
      - { displayName: Adele Vance, whenCreated: "2026-02-03T04:05:06Z", litigationHoldEnabled: true, owner: { displayName: Lee Gu }, type: UserMailbox }
      - { displayName: Reception, whenCreated: "2025-06-01T00:00:00Z", litigationHoldEnabled: false, type: SharedMailbox }
      - { displayName: Room 1, whenCreated: null, litigationHoldEnabled: false, type: UserMailbox }
    transform: >-
      \${ (
        $rows := $applyAdvanced(value, advanced);
        { "rows": [$rows[$$.params.type = 'All' or type = $$.params.type].displayName], "total": $count(value) }
      ) }
layout:
  - { widget: kpi, data: mailboxes.total }
`;

let env: ContentEnv;
beforeAll(() => {
  env = setupContent();
  const file = path.join(env.contentDir, 'pages/deps/mailboxes.page.yaml');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, MAILBOXES);
});
afterAll(() => env.cleanup());

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

describe('query builder filters on rows (dialect: rows)', () => {
  it('filters the rows server-side with the validated filter, combined with ordinary params', async () => {
    const t = await liveApp(env, () => json({}));
    const h = { cookie: t.cookie, 'x-adminforge-csrf': t.csrf };
    const exec = async (params: Record<string, unknown>) => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/datasources/execute',
        headers: h,
        payload: { page: 'deps.mailboxes', datasource: 'mailboxes', params },
      });
      return { status: res.statusCode, body: res.json() as { data?: { rows: string[]; total: number } } };
    };

    expect((await exec({})).body.data).toEqual({ rows: ['Adele Vance', 'Reception', 'Room 1'], total: 3 });
    expect(
      (await exec({ adv: { all: [{ field: 'hold', op: 'eq', value: false }] } })).body.data?.rows,
    ).toEqual(['Reception', 'Room 1']);
    // URL form, mapped properties (dates resolved server-side, nested paths) and the type facet together.
    const r = await exec({
      type: 'UserMailbox',
      adv: b64({
        any: [
          { field: 'created', op: 'ge', value: '2026-01-01' },
          { field: 'owner', op: 'eq', value: 'nobody' },
        ],
      }),
    });
    expect([r.status, r.body.data?.rows]).toEqual([200, ['Adele Vance']]);
    expect(
      (await exec({ adv: { all: [{ field: 'displayName', op: 'contains', value: 'OOM' }] } })).body.data
        ?.rows,
    ).toEqual(['Room 1']);
    expect(t.calls).toHaveLength(0);
    await t.app.close();
  });

  it('rejects unknown fields, wrong types and operators with 400', async () => {
    const t = await liveApp(env, () => json({}));
    const h = { cookie: t.cookie, 'x-adminforge-csrf': t.csrf };
    const cases: Array<[unknown, RegExp]> = [
      ['litigationHoldEnabled eq true', /must be the query builder filter/],
      [{ all: [{ field: 'type', op: 'eq', value: 'UserMailbox' }] }, /unknown field/],
      [{ all: [{ field: 'hold', op: 'eq', value: 'yes' }] }, /expects true or false/],
      [{ all: [{ field: 'owner', op: 'contains', value: 'Lee' }] }, /does not support "contains"/],
    ];
    for (const [adv, pattern] of cases) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/datasources/execute',
        headers: h,
        payload: { page: 'deps.mailboxes', datasource: 'mailboxes', params: { adv } },
      });
      expect(res.statusCode).toBe(400);
      const err = ApiErrorBody.parse(res.json()).error;
      expect([err.code, pattern.test(err.message)]).toEqual(['invalid_params', true]);
    }
    await t.app.close();
  });
});
