import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listContent, type ListedDefinition } from '@adminforge/cli/src/commands/list';
import { newDefinition } from '@adminforge/cli/src/commands/new';
import { contentContext, type ContentCliContext } from '@adminforge/cli/src/content/context';
import { ConfigError } from '@adminforge/cli/src/shared/errors';
import { repoRoot } from '../../lib/repo';

// O-05: `adminforge list` is how people and Claude Code search content before adding (CLAUDE.md rule 4). Folders
// follow ids, so the section a definition shows in — `nav.section`, a report's `area`, a probe's `group`, the target
// of a schedule — is a column and a filter: `--section exchange` finds the Exchange pages and reports kept under
// `m365/`, and (by tag) the Exchange playbooks, which have no navigation entry. Like the other content commands it
// reads the runtime configuration only, never <env>.admin.env.

// Records the configuration each content context is built from (the real function still builds it).
const contexts = vi.hoisted(() => [] as Array<Record<string, string | undefined>>);
vi.mock('@adminforge/cli/src/content/context', async (importOriginal) => {
  const real = await importOriginal<typeof import('@adminforge/cli/src/content/context')>();
  return {
    ...real,
    contentContext: (env: Record<string, string | undefined>, out: (l: string) => void, root: string) => {
      contexts.push(env);
      return real.contentContext(env, out, root);
    },
  };
});

const NAV = `kind: navigation
id: portal.navigation
version: 1.0.0
title: Navigation
owner: t
sections:
  - { key: identity, label: Identity, icon: identification-card }
  - { key: m365, label: Microsoft 365, icon: squares-four }
  - { key: exchange, label: Exchange, icon: envelope }
`;

const SCHEDULE = `kind: schedule
id: reports.external-forwarding-weekly
version: 1.0.0
title: Weekly external forwarding
summary: Writes the external forwarding report every Monday.
owner: t
cron: "0 6 * * 1"
timezone: UTC
enabled: false
identity: automation
job:
  kind: report
  ref: m365.external-forwarding
  delivery:
    - { type: file, format: xlsx }
`;

/** A small library: Exchange content filed under m365/ (as the real one is), plus identity content. */
async function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), 'af-list-'));
  const contentDir = path.join(root, 'content');
  mkdirSync(contentDir, { recursive: true });
  writeFileSync(path.join(contentDir, 'navigation.yaml'), NAV);
  const lines: string[] = [];
  const ctx: ContentCliContext = {
    env: {},
    out: (l) => lines.push(l),
    repoRoot,
    contentDir,
    fixturesDir: path.join(root, 'fixtures'),
  };
  const edit = (file: string, change: (yaml: string) => string) =>
    writeFileSync(file, change(readFileSync(file, 'utf8')));
  const mailboxes = await newDefinition(ctx, 'page', 'm365/mailboxes');
  edit(mailboxes.file, (y) => y.replace('section: m365', 'section: exchange'));
  await newDefinition(ctx, 'page', 'm365/groups');
  const forwarding = await newDefinition(ctx, 'report', 'm365/external-forwarding');
  edit(forwarding.file, (y) => `${y}area: exchange\n`);
  await newDefinition(ctx, 'probe', 'exchange/queue-depth');
  const stale = await newDefinition(ctx, 'page', 'identity/stale-guests');
  edit(stale.file, (y) => y.replace('version: 0.1.0', 'version: 0.2.0\nstatus: retired'));
  await newDefinition(ctx, 'playbook', 'identity/disable-user');
  const forward = await newDefinition(ctx, 'playbook', 'm365/set-mailbox-forwarding');
  edit(forward.file, (y) => y.replace('tags: [m365]', 'tags: [m365, exchange]'));
  mkdirSync(path.join(contentDir, 'schedules', 'reports'), { recursive: true });
  writeFileSync(
    path.join(contentDir, 'schedules', 'reports', 'external-forwarding-weekly.schedule.yaml'),
    SCHEDULE,
  );
  lines.length = 0;
  return { ctx, contentDir, lines, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const ids = (rows: ListedDefinition[]) => rows.map((r) => r.id);

describe('adminforge list', () => {
  it('prints id, kind, section, status and file for every definition, grouped by section', async () => {
    const w = await workspace();
    try {
      const rows = await listContent(w.ctx);
      expect(rows.map((r) => [r.id, r.kind, r.section, r.status, r.file])).toEqual([
        ['m365.mailboxes', 'page', 'exchange', 'active', 'pages/m365/mailboxes.page.yaml'],
        [
          'm365.external-forwarding',
          'report',
          'exchange',
          'active',
          'reports/m365/external-forwarding.report.yaml',
        ],
        [
          'reports.external-forwarding-weekly',
          'schedule',
          'exchange',
          'active',
          'schedules/reports/external-forwarding-weekly.schedule.yaml',
        ],
        ['exchange.queue-depth', 'probe', 'exchange', 'active', 'probes/exchange/queue-depth.probe.yaml'],
        ['identity.stale-guests', 'page', 'identity', 'retired', 'pages/identity/stale-guests.page.yaml'],
        [
          'identity.disable-user',
          'playbook',
          'identity',
          'active',
          'playbooks/identity/disable-user.playbook.yaml',
        ],
        ['m365.groups', 'page', 'm365', 'active', 'pages/m365/groups.page.yaml'],
        [
          'm365.set-mailbox-forwarding',
          'playbook',
          'm365',
          'active',
          'playbooks/m365/set-mailbox-forwarding.playbook.yaml',
        ],
        ['portal.navigation', 'navigation', 'portal', 'active', 'navigation.yaml'],
      ]);
      expect(w.lines[0]).toMatch(/^id {2,}kind {2,}section {2,}status {2,}file$/);
      expect(w.lines[1]).toMatch(
        /^m365\.mailboxes {2,}page {2,}exchange {2,}active {2,}pages\/m365\/mailboxes\.page\.yaml$/,
      );
      // Columns line up (ids and kinds have no spaces).
      const sectionAt = (l: string) => /^\S+ {2,}\S+ {2,}/.exec(l)![0].length;
      expect(new Set(w.lines.slice(0, 10).map(sectionAt)).size).toBe(1);
      expect(w.lines.at(-1)).toBe('9 of 9 definitions.');
    } finally {
      w.cleanup();
    }
  });

  it('--section matches where a definition shows, its id prefix (the folder) or a tag', async () => {
    const w = await workspace();
    try {
      expect(ids(await listContent(w.ctx, { section: 'exchange' }))).toEqual([
        'm365.mailboxes',
        'm365.external-forwarding',
        'reports.external-forwarding-weekly',
        'exchange.queue-depth',
        'm365.set-mailbox-forwarding', // no navigation entry: found by its exchange tag
      ]);
      // m365/ also holds the Exchange content; the section column says where each one shows.
      expect(ids(await listContent(w.ctx, { section: 'm365' }))).toEqual([
        'm365.mailboxes',
        'm365.external-forwarding',
        'm365.groups',
        'm365.set-mailbox-forwarding',
      ]);
      expect(ids(await listContent(w.ctx, { section: 'exchange,identity', kind: 'page' }))).toEqual([
        'm365.mailboxes',
        'identity.stale-guests',
      ]);
    } finally {
      w.cleanup();
    }
  });

  it('filters by kind and status, and searches id, title, summary, tags and file for every word', async () => {
    const w = await workspace();
    try {
      expect(ids(await listContent(w.ctx, { kind: 'report,schedule' }))).toEqual([
        'm365.external-forwarding',
        'reports.external-forwarding-weekly',
      ]);
      expect(ids(await listContent(w.ctx, { kind: 'pages' }))).toEqual([
        'm365.mailboxes',
        'identity.stale-guests',
        'm365.groups',
      ]);
      expect(ids(await listContent(w.ctx, { status: 'retired' }))).toEqual(['identity.stale-guests']);
      expect(ids(await listContent(w.ctx, { search: 'Forwarding MONDAY' }))).toEqual([
        'reports.external-forwarding-weekly',
      ]);
      expect(ids(await listContent(w.ctx, { search: 'disable' }))).toEqual(['identity.disable-user']);
      w.lines.length = 0;
      expect(await listContent(w.ctx, { search: 'nothing-like-this' })).toEqual([]);
      expect(w.lines).toEqual(['0 of 9 definitions.']);
    } finally {
      w.cleanup();
    }
  });

  it('--json prints the rows only, with title, owner, version and tags', async () => {
    const w = await workspace();
    try {
      await listContent(w.ctx, { kind: 'probe', json: true });
      expect(JSON.parse(w.lines.join('\n'))).toEqual([
        {
          id: 'exchange.queue-depth',
          kind: 'probe',
          section: 'exchange',
          status: 'active',
          preview: false,
          title: 'Queue depth',
          owner: 'exchange-team',
          version: '0.1.0',
          tags: ['exchange'],
          file: 'probes/exchange/queue-depth.probe.yaml',
        },
      ]);
    } finally {
      w.cleanup();
    }
  });

  it('refuses an unknown kind or status and names the ones it knows', async () => {
    const w = await workspace();
    try {
      await expect(listContent(w.ctx, { kind: 'widget' })).rejects.toThrow(ConfigError);
      await expect(listContent(w.ctx, { kind: 'widget' })).rejects.toThrow(
        /Unknown kind "widget"\. Use page, dashboard, report, playbook, runbook, schedule, probe, connection, navigation, feed/,
      );
      await expect(listContent(w.ctx, { status: 'gone' })).rejects.toThrow(
        /Unknown status "gone"\. Use draft, preview, active, deprecated, retired/,
      );
    } finally {
      w.cleanup();
    }
  });

  it('lists what loads and says how many files could not be read', async () => {
    const w = await workspace();
    try {
      writeFileSync(path.join(w.contentDir, 'pages', 'identity', 'broken.page.yaml'), 'kind: page\nid: [\n');
      const rows = await listContent(w.ctx, { section: 'identity' });
      expect(ids(rows)).toEqual(['identity.stale-guests', 'identity.disable-user']);
      expect(w.lines).toContain(
        '⚠ 1 file could not be read and is not listed: adminforge validate says why.',
      );
    } finally {
      w.cleanup();
    }
  });
});

describe('adminforge list on portal/content', () => {
  // The real library: the Exchange pages and reports live under m365/ but show in the Exchange section.
  it('--section exchange finds the Exchange pages, reports, playbooks, probes and schedules wherever they are filed', async () => {
    const ctx = contentContext({}, () => undefined, repoRoot);
    const rows = await listContent(ctx, { section: 'exchange' });
    const row = (id: string) => rows.find((r) => r.id === id);
    expect(row('m365.mailboxes')).toMatchObject({ kind: 'page', file: 'pages/m365/mailboxes.page.yaml' });
    expect(row('m365.external-forwarding')).toMatchObject({
      kind: 'report',
      file: 'reports/m365/external-forwarding.report.yaml',
    });
    expect(row('exchange.overview')).toMatchObject({ kind: 'dashboard' });
    expect(row('probes.dns-mx')).toMatchObject({ kind: 'probe', file: 'probes/dns-mx.probe.yaml' });
    expect(row('reports.external-forwarding-weekly')).toMatchObject({
      kind: 'schedule',
      section: 'exchange',
    });
    expect(row('m365.set-mailbox-forwarding')).toMatchObject({
      kind: 'playbook',
      file: 'playbooks/m365/set-mailbox-forwarding.playbook.yaml',
    });
    expect(rows.some((r) => r.id === 'm365.groups')).toBe(false);
  }, 60_000);
});

describe('adminforge list on the command line', () => {
  const saved = { file: process.env.ADMINFORGE_ENV_FILE, overlay: process.env.ADMINFORGE_ENV_OVERLAY };
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'af-list-cli-'));
    const contentDir = path.join(dir, 'content');
    mkdirSync(contentDir);
    writeFileSync(path.join(contentDir, 'navigation.yaml'), NAV);
    // CONTENT_DIR comes from the runtime env file; the admin file sits next to it and must stay unread.
    writeFileSync(path.join(dir, 'dev.env'), `RUNTIME_FILE_MARK=1\nCONTENT_DIR=${contentDir}\n`, {
      mode: 0o600,
    });
    writeFileSync(
      path.join(dir, 'dev.admin.env'),
      'ADMIN_FILE_MARK=1\nAF_PROVISIONER_CLIENT_SECRET=synthetic-provisioner-secret\n',
      { mode: 0o600 },
    );
    process.env.ADMINFORGE_ENV_FILE = path.join(dir, 'dev.env');
    delete process.env.ADMINFORGE_ENV_OVERLAY;
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved.file === undefined) delete process.env.ADMINFORGE_ENV_FILE;
    else process.env.ADMINFORGE_ENV_FILE = saved.file;
    if (saved.overlay !== undefined) process.env.ADMINFORGE_ENV_OVERLAY = saved.overlay;
  });

  it('reads the runtime configuration only, and the content directory it names', async () => {
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((l: string) => void printed.push(l));
    const argv = process.argv;
    process.argv = [process.execPath, 'adminforge', 'list', '--kind', 'navigation', '--json'];
    contexts.length = 0;
    vi.resetModules();
    try {
      await import('@adminforge/cli/src/index');
    } finally {
      process.argv = argv;
      log.mockRestore();
    }
    const failed = process.exitCode;
    process.exitCode = undefined;
    expect(failed ?? 0).toBe(0);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.RUNTIME_FILE_MARK).toBe('1');
    expect(contexts[0]!.ADMIN_FILE_MARK, 'the admin file was read').toBeUndefined();
    expect(Object.values(contexts[0]!)).not.toContain('synthetic-provisioner-secret');
    expect(JSON.parse(printed.join('\n'))).toMatchObject([
      { id: 'portal.navigation', file: 'navigation.yaml' },
    ]);
  }, 30_000);
});
