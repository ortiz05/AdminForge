import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkContent, scriptHasher } from '@adminforge/cli/src/content/check';
import type { ContentCliContext } from '@adminforge/cli/src/content/context';
import { scriptPinProblems } from '@adminforge/cli/src/content/lint';
import { newDefinition } from '@adminforge/cli/src/commands/new';
import { validateContent } from '@adminforge/cli/src/commands/validate';
import { repoRoot } from '../../lib/repo';

// The runner refuses a script whose sha256 differs from the pin (§5.10); `adminforge validate` fails first, for every
// definition kind that references a script (datasources, playbook steps and compensations, schedules).
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const SCRIPT = 'Write-Output "pinned"\n';
const GOOD = sha(SCRIPT);
const STALE = sha('Write-Output "old"\n');

describe('scriptPinProblems', () => {
  const lookup = (script: string) => (script === 'exchange/Get-Pinned.ps1' ? GOOD : null);

  it('accepts references whose pin is the file sha256', () => {
    expect(
      scriptPinProblems(
        { datasources: { box: { source: 'runner', script: 'exchange/Get-Pinned.ps1', sha256: GOOD } } },
        lookup,
      ),
    ).toEqual([]);
  });

  it('reports stale pins and missing scripts wherever they are, with the path to the pin', () => {
    const problems = scriptPinProblems(
      {
        datasources: { box: { source: 'runner', script: 'exchange/Get-Pinned.ps1', sha256: STALE } },
        steps: [
          { id: 'read', type: 'http' },
          {
            id: 'change',
            type: 'runner',
            script: 'exchange/Get-Pinned.ps1',
            sha256: GOOD,
            compensate: { type: 'runner', script: 'exchange/Gone.ps1', sha256: GOOD },
          },
        ],
      },
      lookup,
    );
    expect(problems).toEqual([
      {
        segments: ['datasources', 'box', 'sha256'],
        path: 'datasources.box.sha256',
        script: 'exchange/Get-Pinned.ps1',
        pinned: STALE,
        actual: GOOD,
      },
      {
        segments: ['steps', 1, 'compensate', 'sha256'],
        path: 'steps[1].compensate.sha256',
        script: 'exchange/Gone.ps1',
        pinned: GOOD,
        actual: null,
      },
    ]);
  });

  it('ignores objects that are not runner references', () => {
    expect(scriptPinProblems({ script: 'only a script' }, lookup)).toEqual([]);
    expect(scriptPinProblems({ sha256: GOOD }, lookup)).toEqual([]);
    expect(scriptPinProblems(null, lookup)).toEqual([]);
  });
});

describe('scriptHasher', () => {
  it('hashes the file bytes and returns null for missing files or paths outside the scripts directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'af-pins-'));
    try {
      mkdirSync(path.join(dir, 'scripts', 'exchange'), { recursive: true });
      writeFileSync(path.join(dir, 'scripts', 'exchange', 'Get-Pinned.ps1'), SCRIPT);
      writeFileSync(path.join(dir, 'outside.ps1'), SCRIPT);
      const hash = scriptHasher(path.join(dir, 'scripts'));
      expect(hash('exchange/Get-Pinned.ps1')).toBe(GOOD);
      expect(hash('exchange/Missing.ps1')).toBeNull();
      expect(hash('../outside.ps1')).toBeNull();
      expect(hash('exchange')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('adminforge validate: script pins', () => {
  const NAV = `kind: navigation
id: portal.navigation
version: 1.0.0
title: Navigation
owner: t
sections:
  - { key: identity, label: Identity, icon: identification-card }
`;

  /** A content directory with one page whose runner datasource pins `pin`. */
  async function workspace(pin: string, script = 'exchange/Get-Pinned.ps1') {
    const root = mkdtempSync(path.join(tmpdir(), 'af-pins-'));
    const contentDir = path.join(root, 'content');
    mkdirSync(path.join(contentDir, 'scripts', 'exchange'), { recursive: true });
    writeFileSync(path.join(contentDir, 'navigation.yaml'), NAV);
    writeFileSync(path.join(contentDir, 'scripts', 'exchange', 'Get-Pinned.ps1'), SCRIPT);
    const lines: string[] = [];
    const ctx: ContentCliContext = {
      env: {},
      out: (l) => lines.push(l),
      repoRoot,
      contentDir,
      fixturesDir: path.join(root, 'fixtures'),
    };
    const { file } = await newDefinition(ctx, 'page', 'identity/pinned');
    const yaml = readFileSync(file, 'utf8').replace(
      'datasources:\n',
      `datasources:\n  mailbox:\n    source: runner\n    script: ${script}\n    sha256: ${pin}\n    services: [exchange]\n`,
    );
    writeFileSync(file, yaml);
    lines.length = 0;
    const pinLine = yaml.split('\n').findIndex((l) => l.includes(`sha256: ${pin}`)) + 1;
    return { ctx, lines, pinLine, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it('passes when the pin matches the script', async () => {
    const w = await workspace(GOOD);
    try {
      expect((await checkContent(w.ctx)).errors).toEqual([]);
    } finally {
      w.cleanup();
    }
  });

  it('fails on a stale pin with the file sha256, at the pin line', async () => {
    const w = await workspace(STALE);
    try {
      expect(await validateContent(w.ctx)).toBe(false);
      expect(w.lines).toContain(
        `✗ pages/identity/pinned.page.yaml:${w.pinLine} datasources.mailbox.sha256: pinned sha256 does not match ${path.relative(repoRoot, w.ctx.contentDir).split(path.sep).join('/')}/scripts/exchange/Get-Pinned.ps1 (its sha256 is ${GOOD}) — update the pin; the runner refuses a script whose sha256 differs.`,
      );
    } finally {
      w.cleanup();
    }
  });

  it('fails when the script does not exist', async () => {
    const w = await workspace(GOOD, 'exchange/Missing.ps1');
    try {
      const { errors } = await checkContent(w.ctx);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(
        new RegExp(
          `^pages/identity/pinned\\.page\\.yaml:${w.pinLine} datasources\\.mailbox\\.sha256: script .*/scripts/exchange/Missing\\.ps1 does not exist\\.$`,
        ),
      );
    } finally {
      w.cleanup();
    }
  });
});
