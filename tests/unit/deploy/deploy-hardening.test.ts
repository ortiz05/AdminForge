import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoRoot } from '../../lib/repo';

// Deploy scripts refuse input that would change what they do: keys other than the Postgres constants in the deploy
// defaults (they would reach the backup's child processes), and checkout paths that aren't safe in a systemd unit.
const DEFAULTS_SH = path.join(repoRoot, 'portal/deploy/lib/defaults.sh');
const INSTALL = path.join(repoRoot, 'portal/deploy/install-units.sh');

describe('deploy defaults loader', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'af-defaults-'));
    mkdirSync(path.join(dir, 'lib'));
    writeFileSync(path.join(dir, 'lib', 'defaults.sh'), readFileSync(DEFAULTS_SH, 'utf8'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const load = (content: string) => {
    writeFileSync(path.join(dir, 'defaults.env'), content);
    return spawnSync(
      'bash',
      [
        '-c',
        `. "${path.join(dir, 'lib', 'defaults.sh')}" && af_load_deploy_defaults && echo "port=$AF_PG_PORT"`,
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
    );
  };

  it('loads the AF_PG_* constants, skipping comments and blank lines', () => {
    const r = load('# deploy constants\n\nAF_PG_PORT=55432\nAF_PG_USER=adminforge\n');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('port=55432');
  });

  it('refuses any other key (e.g. DOCKER_HOST, BASH_ENV) instead of exporting it', () => {
    for (const bad of ['DOCKER_HOST=tcp://example.com:2375', 'BASH_ENV=/tmp/x']) {
      const r = load(`AF_PG_PORT=55432\n${bad}\n`);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/unexpected key \w+ \(only AF_PG_\*/);
    }
  });
});

describe('install-units.sh checkout path', () => {
  it.each(['Admin Forge', 'a&b', 'a#b', 'a%hb'])('refuses a checkout path with %j', (name) => {
    const root = mkdtempSync(path.join(tmpdir(), 'af-units-bad-'));
    try {
      const checkout = path.join(root, name);
      mkdirSync(path.join(checkout, 'portal', 'apps'), { recursive: true });
      const r = spawnSync(
        'bash',
        [INSTALL, '--checkout', checkout, '--target', path.join(root, 'units'), '--dry-run'],
        { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root } },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/aren't safe in a systemd unit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
