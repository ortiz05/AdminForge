import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadContentDir, type LoadedDefinition } from '@adminforge/schemas';
import {
  checkContent,
  expectedFolder,
  FOLDER_EXCEPTIONS,
  folderPrefixProblem,
} from '@adminforge/cli/src/content/check';
import type { ContentCliContext } from '@adminforge/cli/src/content/context';
import { newDefinition } from '@adminforge/cli/src/commands/new';
import { validateContent } from '@adminforge/cli/src/commands/validate';
import { repoRoot } from '../../lib/repo';

// O-05 (option b): nothing moves, but a definition's folder is its id prefix — `pages/identity/` holds
// `identity.*` pages — so "reuse before adding" can trust the folders. `adminforge validate` (and the publish gate)
// refuses a file anywhere else and says which folder it belongs in. A short list of folders predates the rule; each
// must still be in use, so the list can't rot.

const NAV = `kind: navigation
id: portal.navigation
version: 1.0.0
title: Navigation
owner: t
sections:
  - { key: identity, label: Identity, icon: identification-card }
  - { key: exchange, label: Exchange, icon: envelope }
`;

describe('where a definition belongs', () => {
  it.each([
    ['page', 'identity.users', 'pages/identity'],
    ['report', 'm365.external-forwarding', 'reports/m365'],
    ['schedule', 'reports.inactive-users-weekly', 'schedules/reports'],
    ['dashboard', 'billing.overview', 'dashboards/billing'],
    ['probe', 'probes.dns-mx', 'probes'],
    ['probe', 'exchange.queue-depth', 'probes/exchange'],
    ['feed', 'feeds.m365-roadmap', 'feeds'],
    ['connection', 'integrations.hr-api', 'connections/integrations'],
  ])('a %s with id %s belongs in %s/', (kind, id, folder) => {
    expect(expectedFolder({ kind, id })).toBe(folder);
  });

  it('accepts a file in its folder, and the navigation at the content root', () => {
    expect(
      folderPrefixProblem('pages/identity/users.page.yaml', { kind: 'page', id: 'identity.users' }),
    ).toBe(null);
    expect(folderPrefixProblem('probes/dns-mx.probe.yaml', { kind: 'probe', id: 'probes.dns-mx' })).toBe(
      null,
    );
    expect(folderPrefixProblem('navigation.yaml', { kind: 'navigation', id: 'portal.navigation' })).toBe(
      null,
    );
  });

  it.each([
    // [file, kind, id, the folder the message names]
    ['pages/m365/mailboxes.page.yaml', 'page', 'exchange.mailboxes', 'pages/exchange/'],
    ['reports/identity/x.page.yaml', 'page', 'identity.x', 'pages/identity/'],
    ['pages/x.page.yaml', 'page', 'identity.x', 'pages/identity/'],
    ['x.page.yaml', 'page', 'identity.x', 'pages/identity/'],
    ['pages/identity/more/x.page.yaml', 'page', 'identity.x', 'pages/identity/'],
    ['probes/probes/x.probe.yaml', 'probe', 'probes.x', 'probes/'],
    ['probes/x.probe.yaml', 'probe', 'exchange.x', 'probes/exchange/'],
    ['schedules/probes/x.schedule.yaml', 'schedule', 'reports.x', 'schedules/reports/'],
  ])('refuses %s (%s %s) and names %s', (file, kind, id, folder) => {
    const problem = folderPrefixProblem(file, { kind, id });
    expect(problem).toContain(`${id} belongs in ${folder}`);
    expect(problem).toContain('portal/content/README.md');
  });

  it('keeps the listed exceptions, and only for the ids they hold', () => {
    // Section overview dashboards sit flat in dashboards/; their prefix is the section they open.
    const overview = { kind: 'dashboard', id: 'exchange.overview', nav: { section: 'exchange' } };
    expect(folderPrefixProblem('dashboards/exchange.dashboard.yaml', overview)).toBe(null);
    expect(
      folderPrefixProblem('dashboards/other.dashboard.yaml', { ...overview, nav: { section: 'identity' } }),
    ).toContain('exchange.overview belongs in dashboards/exchange/');
    expect(
      folderPrefixProblem('dashboards/exchange.dashboard.yaml', {
        kind: 'dashboard',
        id: 'exchange.overview',
      }),
    ).toContain('belongs in dashboards/exchange/');
    // The probe sweeps (sweep.*) are grouped with the probes they run.
    expect(
      folderPrefixProblem('schedules/probes/hourly.schedule.yaml', { kind: 'schedule', id: 'sweep.hourly' }),
    ).toBe(null);
    // The one connection that predates the rule.
    expect(
      folderPrefixProblem('connections/hr-sync.connection.yaml', {
        kind: 'connection',
        id: 'integrations.hr-sync',
      }),
    ).toBe(null);
    expect(
      folderPrefixProblem('connections/x.connection.yaml', { kind: 'connection', id: 'billing.x' }),
    ).toContain('belongs in connections/billing/');
    expect(FOLDER_EXCEPTIONS.map((e) => e.folder)).toEqual(['dashboards', 'schedules/probes', 'connections']);
  });
});

describe('the content library', () => {
  let loaded: LoadedDefinition[];
  beforeAll(async () => {
    loaded = (await loadContentDir(path.join(repoRoot, 'portal', 'content'), { references: false }))
      .definitions;
  }, 60_000);

  it('keeps every definition in the folder its id names', () => {
    expect(loaded.length).toBeGreaterThan(400);
    const problems = loaded.flatMap((d) => folderPrefixProblem(d.file, d.def) ?? []);
    expect(problems).toEqual([]);
  });

  it('still uses every listed exception (remove one that no longer holds a file)', () => {
    // Files the exception alone lets through: in its folder, held by it, and not where the general rule puts them.
    for (const e of FOLDER_EXCEPTIONS) {
      const held = loaded.filter(
        (d) =>
          path.posix.dirname(d.file) === e.folder &&
          e.holds(d.def) &&
          path.posix.dirname(d.file) !== expectedFolder(d.def),
      );
      expect(held.length, `${e.folder}/ (${e.ids})`).toBeGreaterThan(0);
    }
  });
});

describe('adminforge validate', () => {
  function workspace() {
    const root = mkdtempSync(path.join(tmpdir(), 'af-folders-'));
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
    return { ctx, contentDir, lines, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it('refuses a page filed under another section, at the line of its id, and names the folder', async () => {
    const w = workspace();
    try {
      const { file } = await newDefinition(w.ctx, 'page', 'exchange/mailboxes');
      const moved = path.join(w.contentDir, 'pages', 'identity', 'mailboxes.page.yaml');
      mkdirSync(path.dirname(moved), { recursive: true });
      renameSync(file, moved);
      const line = readFileSync(moved, 'utf8').split('\n').indexOf('id: exchange.mailboxes') + 1;
      w.lines.length = 0;
      expect(await validateContent(w.ctx)).toBe(false);
      expect(w.lines).toContain(
        `✗ pages/identity/mailboxes.page.yaml:${line} id: exchange.mailboxes belongs in pages/exchange/ — a definition's folder is its id prefix (portal/content/README.md). Move the file: a published id never changes.`,
      );
      expect(w.lines.at(-1)).toMatch(/^✗ 1 problem\(s\)/);
    } finally {
      w.cleanup();
    }
  });

  it('accepts what `adminforge new` scaffolds, flat probes and feeds included', async () => {
    const w = workspace();
    try {
      await newDefinition(w.ctx, 'page', 'identity/stale-groups');
      await newDefinition(w.ctx, 'probe', 'probes/graph-org');
      await newDefinition(w.ctx, 'probe', 'exchange/queue-depth');
      await newDefinition(w.ctx, 'feed', 'feeds/example-board');
      await newDefinition(w.ctx, 'schedule', 'maintenance/content-health');
      const report = await checkContent(w.ctx);
      expect(report.errors).toEqual([]);
      expect(report.loaded.map((d) => d.file).sort()).toEqual([
        'feeds/example-board.feed.yaml',
        'navigation.yaml',
        'pages/identity/stale-groups.page.yaml',
        'probes/exchange/queue-depth.probe.yaml',
        'probes/graph-org.probe.yaml',
        'schedules/maintenance/content-health.schedule.yaml',
      ]);
    } finally {
      w.cleanup();
    }
  });
});
