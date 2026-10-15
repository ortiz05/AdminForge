import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { formatContentError, loadContentDir, validateReferences } from '@adminforge/schemas';
import { ENVELOPE } from './helpers';

let dir: string;
const put = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'af-content-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NAV = `${ENVELOPE('navigation', 'portal.navigation')}sections:\n  - { key: identity, label: Identity, icon: users }\n`;
const PLAYBOOK = `${ENVELOPE('playbook', 'identity.disable-user')}risk: low\nmode: write\ninputs:\n  userId: { type: user }\nsteps:\n  - { id: d, type: graph, mode: write, describe: Disable, request: { method: PATCH, path: /users/x, body: {} } }\n`;
const READ_PB = `${ENVELOPE('playbook', 'identity.lookup')}risk: low\nmode: read\nsteps:\n  - { id: l, type: graph, request: { path: /me } }\n`;
const CONN = `${ENVELOPE('connection', 'integrations.hr-sync')}baseUrl: https://hr.example.com\naudience: api://hr\noperations:\n  list: { path: /api/list, mode: read }\n  sync: { method: POST, path: /api/sync, mode: write }\n`;
const page = (id: string, table: string, extra = '') =>
  `${ENVELOPE('page', id)}template: list-detail\nnav: { section: identity }\n${extra}layout:\n  - widget: table\n    data: users.value\n    columns: [{ field: id, label: Id }]\n${table}`;

describe('loadContentDir', () => {
  it('loads YAML recursively, skipping dot dirs, fixtures/ and scripts/', async () => {
    put('navigation.yaml', NAV);
    put('playbooks/identity/disable-user.playbook.yaml', PLAYBOOK);
    put('pages/identity/users.page.yml', page('identity.users', ''));
    put('.drafts/x.page.yaml', 'not: valid');
    put('fixtures/graph/v1.0/users/GET.yaml', 'not: valid');
    put('scripts/exchange/x.yaml', 'not: valid');
    put('notes.md', '# not content');
    const r = await loadContentDir(dir);
    expect(r.errors).toEqual([]);
    expect(r.definitions.map((d) => d.file)).toEqual(['navigation.yaml', 'pages/identity/users.page.yml', 'playbooks/identity/disable-user.playbook.yaml']);
    expect(r.definitions[2]!.sha256).toBe(createHash('sha256').update(PLAYBOOK).digest('hex'));
  });
  it('collects schema errors from every file with lines', async () => {
    put('a.page.yaml', `${ENVELOPE('page', 'test.a')}template: list-detail\n`);
    put('b.probe.yaml', `${ENVELOPE('probe', 'test.b')}check: { kind: graph }\n`);
    const r = await loadContentDir(dir);
    expect(r.errors.map(formatContentError)).toEqual(['a.page.yaml:1 layout: Add at least one widget to layout (or tabs).', 'b.probe.yaml:6 check.path: Invalid input: expected string, received undefined']);
  });
  it('reports duplicate ids across files', async () => {
    put('a.playbook.yaml', READ_PB);
    put('b/again.playbook.yaml', READ_PB);
    const r = await loadContentDir(dir);
    expect(r.errors).toEqual([{ file: 'b/again.playbook.yaml', path: 'id', line: 2, message: 'Duplicate id "identity.lookup" (also in a.playbook.yaml).' }]);
  });
  it('can skip reference checks', async () => {
    put('p.page.yaml', page('identity.users', '    inspect: { page: identity.nope }\n'));
    expect((await loadContentDir(dir)).errors).toHaveLength(1);
    expect((await loadContentDir(dir, { references: false })).errors).toEqual([]);
  });
});

describe('validateReferences', () => {
  const load = async () => (await loadContentDir(dir)).errors.map((e) => `${e.file}:${e.line} ${e.path}: ${e.message}`);

  it('checks page links to pages, playbooks and their inputs', async () => {
    put('navigation.yaml', NAV);
    put('pb.playbook.yaml', PLAYBOOK);
    put('lookup.playbook.yaml', READ_PB);
    put(
      'users.page.yaml',
      page(
        'identity.users',
        [
          '    inspect: { page: identity.user }',
          '    rowActions:',
          '      - { playbook: identity.disable-user, inputs: { userId: x, reason: y } }',
          '      - { playbook: integrations.hr-sync }',
          '    bulkActions:',
          '      - { playbook: identity.missing, label: Go, forEach: { inputs: {} } }',
          '',
        ].join('\n'),
      ).replace('nav: { section: identity }', 'nav: { section: azure }'),
    );
    expect(await load()).toEqual([
      'users.page.yaml:7 nav.section: Unknown navigation section "azure".',
      'users.page.yaml:12 layout[0].inspect.page: Unknown page or dashboard or report "identity.user".',
      'users.page.yaml:14 layout[0].rowActions[0].inputs.reason: playbook "identity.disable-user" has no input "reason".',
      'users.page.yaml:15 layout[0].rowActions[1].playbook: Unknown playbook or runbook "integrations.hr-sync".',
      'users.page.yaml:17 layout[0].bulkActions[0].playbook: Unknown playbook "identity.missing".',
    ]);
  });
  it('checks connections and their operations', async () => {
    put('conn.connection.yaml', CONN);
    put(
      'p.page.yaml',
      page('identity.users', '', 'datasources:\n  a: { source: function, connection: integrations.hr-sync, operation: nope }\n  b: { source: function, connection: integrations.hr-sync, operation: sync }\n  c: { source: function, connection: integrations.other, operation: list }\n'),
    );
    put(
      'pb.playbook.yaml',
      `${ENVELOPE('playbook', 'identity.sync')}risk: low\nmode: write\nsteps:\n  - { id: s, type: function, connection: integrations.hr-sync, operation: sync }\n  - { id: t, type: function, mode: write, describe: Sync, connection: integrations.hr-sync, operation: sync }\n`,
    );
    expect(await load()).toEqual([
      'p.page.yaml:9 datasources.a.operation: Connection "integrations.hr-sync" has no operation "nope".',
      'p.page.yaml:10 datasources.b.operation: Datasources only read; operation "sync" is mode: write.',
      'p.page.yaml:11 datasources.c.connection: Unknown connection "integrations.other".',
      'pb.playbook.yaml:9 steps[0].mode: Operation "sync" is mode: write; declare mode: write.',
    ]);
  });
  it('checks child playbooks, schedules and probes', async () => {
    put('pb.playbook.yaml', PLAYBOOK);
    put('lookup.playbook.yaml', READ_PB);
    put('parent.playbook.yaml', `${ENVELOPE('playbook', 'identity.parent')}risk: low\nmode: read\nsteps:\n  - { id: c, type: playbook, ref: identity.disable-user }\n`);
    put('r.report.yaml', `${ENVELOPE('report', 'identity.r')}params:\n  days: { type: number }\nlayout: [{ widget: kpi }]\nexport: { formats: [csv] }\n`);
    put('s1.schedule.yaml', `${ENVELOPE('schedule', 'reports.s1')}cron: "@daily"\njob: { kind: report, ref: identity.r, params: { weeks: 2 }, delivery: [{ type: file }] }\n`);
    put('s2.schedule.yaml', `${ENVELOPE('schedule', 'reports.s2')}cron: "@daily"\njob: { kind: playbook, ref: identity.disable-user }\n`);
    put('s3.schedule.yaml', `${ENVELOPE('schedule', 'reports.s3')}cron: "@daily"\njob: { kind: probe, ref: identity.lookup }\n`);
    put('conn.connection.yaml', CONN);
    put('fh.probe.yaml', `${ENVELOPE('probe', 'probes.fh')}check: { kind: functionHealth, connection: integrations.hr-sync }\n`);
    expect(await load()).toEqual([
      'fh.probe.yaml:6 check.operation: Connection "integrations.hr-sync" has no health operation; set check.operation.',
      'parent.playbook.yaml:9 steps[0].ref: Child playbook "identity.disable-user" writes; set the top-level mode: write.',
      's1.schedule.yaml:7 job.params.weeks: Report "identity.r" has no param "weeks".',
      's2.schedule.yaml:7 job.mode: Playbook "identity.disable-user" is mode: write; the job must say mode: write.',
      's3.schedule.yaml:7 job.ref: "identity.lookup" is a playbook, expected probe.',
    ]);
  });
  it('accepts a consistent set', async () => {
    put('navigation.yaml', NAV);
    put('pb.playbook.yaml', PLAYBOOK);
    put('users.page.yaml', page('identity.users', '    rowActions: [{ playbook: identity.disable-user, inputs: { userId: x } }]\n'));
    put('s.schedule.yaml', `${ENVELOPE('schedule', 'reports.s')}cron: "@daily"\njob: { kind: playbook, ref: identity.disable-user, mode: write, approvedBy: [approval-1] }\n`);
    expect(await load()).toEqual([]);
  });
  it('works on in-memory definitions too', () => expect(validateReferences([])).toEqual([]));
});
