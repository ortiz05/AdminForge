import { createRequire } from 'node:module';
import path from 'node:path';
import { csvField } from '@adminforge/api/src/reports/export';
import { ApiErrorBody } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';
import { fixturesApp, liveApp, json, setupContent, type ContentEnv } from './content-helpers';
import { mockLogin } from './helpers';

// exceljs is an api dependency (not a tests one); resolve it from there to read the workbook back.
const ExcelJS = createRequire(path.join(repoRoot, 'portal/apps/api/package.json'))('exceljs') as {
  Workbook: new () => {
    xlsx: { load(b: Buffer): Promise<void> };
    worksheets: Array<{ getSheetValues(): unknown[][] }>;
  };
};

let env: ContentEnv;
beforeAll(() => {
  env = setupContent();
});
afterAll(() => env.cleanup());

describe('POST /api/reports/:key/export', () => {
  it('CSV: every page (cursor paging), visible columns, status labels, formula injection neutralised, audited', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/reports/identity.users/export',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { format: 'csv', params: {} },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="users.csv"; filename*=UTF-8''users.csv`,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines).toEqual([
      'Name,Status,Department',
      'Avery Engineer,Enabled,IT',
      'Blake Analyst,Disabled,Finance',
      'Casey Guest,Enabled,',
      `Dana =SUM(A1),Enabled,"Sales, EMEA"`,
    ]);
    await new Promise((r) => setTimeout(r, 20));
    const audit = t.audit.rows.find((r) => r.action === 'report.exported')!;
    expect(audit).toMatchObject({ result: 'success', targetType: 'page', targetId: 'identity.users' });
    expect(audit.details).toMatchObject({
      format: 'csv',
      rows: 4,
      truncated: false,
      columns: ['displayName', 'accountEnabled', 'department'],
    });
    // Cells that start like a formula are neutralised in CSV.
    const report = await t.app.inject({
      method: 'POST',
      url: '/api/reports/identity.expiry/export',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { format: 'csv' },
    });
    expect(report.body.split('\r\n')[1]).toMatch(
      /^Example HR Sync,30000000-0000-4000-8000-000000000021,2026-11-01T00:00:00Z,'=1\+1$/,
    );
    await t.app.close();
  });

  it('the user can pick visible columns; unknown columns are ignored', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/reports/identity.users/export',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { format: 'csv', columns: ['id', 'displayName', 'nope'] },
    });
    expect(res.body.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe('Object id,Name');
    await t.app.close();
  });

  it('XLSX: transformed report, all columns, dates as dates, file name from the template', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/reports/identity.expiry/export',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { format: 'xlsx', params: { days: 60 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers['content-disposition']).toContain('filename="expiry-60d.xlsx"');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload);
    const rows = wb.worksheets[0]!.getSheetValues()
      .filter(Boolean)
      .map((r) => (r as unknown[]).slice(1));
    expect(rows[0]).toEqual(['Application', 'Key id', 'Expires', 'Note']);
    expect(rows).toHaveLength(4);
    expect(rows[1]![0]).toBe('Example HR Sync');
    expect(rows[1]![2]).toBeInstanceOf(Date);
    // Real XLSX cells hold the text; formula injection only concerns CSV.
    expect(rows[1]![3]).toBe('=1+1');
    await t.app.close();
  });

  it('refuses formats the definition does not offer, pages without export, and missing CSRF', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const h = { cookie, 'x-adminforge-csrf': csrf };
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/reports/identity.users/export',
          headers: h,
          payload: { format: 'pdf' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      ApiErrorBody.parse(
        (
          await t.app.inject({
            method: 'POST',
            url: '/api/reports/identity.user/export',
            headers: h,
            payload: { format: 'csv', params: { id: '30000000-0000-4000-8000-000000000001' } },
          })
        ).json(),
      ).error.code,
    ).toBe('export_not_supported');
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/reports/identity.users/export',
          headers: { cookie },
          payload: { format: 'csv' },
        })
      ).statusCode,
    ).toBe(403);
    await t.app.close();
  });

  it('a permission error on the first page returns JSON (with a hint) and is audited as a failure', async () => {
    const t = await liveApp(env, () =>
      json({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges.' } }, 403),
    );
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/reports/identity.users/export',
      headers: { cookie: t.cookie, 'x-adminforge-csrf': t.csrf },
      payload: { format: 'csv' },
    });
    expect(res.statusCode).toBe(403);
    expect(ApiErrorBody.parse(res.json()).error).toMatchObject({
      code: 'upstream_forbidden',
      hint: expect.stringContaining('User.Read.All'),
    });
    expect(t.audit.rows.find((r) => r.action === 'report.exported')).toMatchObject({
      result: 'failure',
      details: expect.objectContaining({ error: 'upstream_forbidden' }),
    });
    await t.app.close();
  });

  it('csvField quoting', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('+1 555')).toBe("'+1 555");
    expect(csvField('@cmd')).toBe("'@cmd");
    expect(csvField(-5)).toBe('-5');
    expect(csvField(null)).toBe('');
  });
});
