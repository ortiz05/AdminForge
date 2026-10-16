import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoRoot } from '../../lib/repo';

// portal/deploy/install-units.sh into a scratch unit directory, for a scratch checkout: which files it writes, that
// they point at the checkout, that a second run changes nothing, and that it never touches local drop-ins.
const SCRIPT = path.join(repoRoot, 'portal/deploy/install-units.sh');
const UNIT_DIR = path.join(repoRoot, 'portal/deploy/systemd');

function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'af-units-'));
  // Plain path characters only: anything else is refused (tests/unit/deploy/deploy-hardening.test.ts).
  const checkout = path.join(root, 'checkouts', 'Admin_Forge.v1+test');
  const target = path.join(root, 'systemd-user');
  mkdirSync(path.join(checkout, 'portal', 'apps'), { recursive: true });
  const run = (...args: string[]) =>
    spawnSync('bash', [SCRIPT, '--checkout', checkout, '--target', target, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root },
    });
  const files = (): string[] =>
    existsSync(target)
      ? (readdirSync(target, { recursive: true }) as string[])
          .filter((f) => statSync(path.join(target, f)).isFile())
          .sort()
      : [];
  return {
    checkout,
    target,
    run,
    files,
    read: (f: string) => readFileSync(path.join(target, f), 'utf8'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const lines = (out: string) => out.trim().split('\n');

describe('install-units.sh', () => {
  it('installs the four services and their hardening drop-ins by default, pointed at the checkout', () => {
    const s = sandbox();
    try {
      const r = s.run();
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const units = ['api', 'worker', 'scheduler', 'runner'];
      expect(s.files()).toEqual(
        units.flatMap((u) => [`adminforge-${u}.service`, `adminforge-${u}.service.d/hardening.conf`]).sort(),
      );
      for (const u of units) {
        const source = readFileSync(path.join(UNIT_DIR, `adminforge-${u}.service`), 'utf8');
        const installed = s.read(`adminforge-${u}.service`);
        expect(installed).toBe(source.split('%h/AdminForge').join(s.checkout));
        expect(installed).not.toContain('%h/AdminForge');
        expect(s.read(`adminforge-${u}.service.d/hardening.conf`)).toBe(
          readFileSync(path.join(UNIT_DIR, 'hardening.conf'), 'utf8'),
        );
        expect(statSync(path.join(s.target, `adminforge-${u}.service`)).mode & 0o777).toBe(0o644);
      }
      expect(s.read('adminforge-api.service')).toContain(`WorkingDirectory=${s.checkout}/portal/apps/api\n`);
      expect(lines(r.stdout).filter((l) => l.startsWith('installed'))).toHaveLength(8);
      expect(r.stdout).toContain('systemctl --user daemon-reload');
      expect(r.stdout).toContain(
        'systemctl --user enable --now adminforge-api adminforge-worker adminforge-scheduler adminforge-runner',
      );
    } finally {
      s.cleanup();
    }
  });

  it('is idempotent and reports only what changed', () => {
    const s = sandbox();
    try {
      expect(s.run('api', 'backup').status).toBe(0);
      const again = s.run('api', 'backup');
      expect(again.status).toBe(0);
      expect(
        lines(again.stdout)
          .slice(0, -1)
          .every((l) => l.startsWith('unchanged')),
      ).toBe(true);
      expect(again.stdout).toContain(`Nothing to change in ${s.target}.`);

      writeFileSync(path.join(s.target, 'adminforge-api.service'), 'stale\n');
      const fixed = s.run('api');
      expect(lines(fixed.stdout)).toContain('updated          adminforge-api.service');
      expect(lines(fixed.stdout)).toContain('unchanged        adminforge-api.service.d/hardening.conf');
      expect(s.read('adminforge-api.service')).toContain(`WorkingDirectory=${s.checkout}/portal/apps/api`);
    } finally {
      s.cleanup();
    }
  });

  it('installs the backup timer with the backup service, and never touches local drop-ins', () => {
    const s = sandbox();
    try {
      mkdirSync(path.join(s.target, 'adminforge-backup.service.d'), { recursive: true });
      writeFileSync(
        path.join(s.target, 'adminforge-backup.service.d', 'override.conf'),
        '[Service]\nEnvironment=X=1\n',
      );
      const r = s.run('backup');
      expect(r.status).toBe(0);
      expect(s.files()).toEqual([
        'adminforge-backup.service',
        'adminforge-backup.service.d/hardening.conf',
        'adminforge-backup.service.d/override.conf',
        'adminforge-backup.timer',
      ]);
      expect(s.read('adminforge-backup.service')).toContain(
        `ExecStart=${s.checkout}/portal/deploy/backup/adminforge-backup.sh\n`,
      );
      expect(s.read('adminforge-backup.service.d/override.conf')).toBe('[Service]\nEnvironment=X=1\n');
      expect(r.stdout).toContain('systemctl --user enable --now adminforge-backup.timer');
      expect(r.stdout).not.toMatch(/enable --now adminforge-backup(?!\.timer)/);
    } finally {
      s.cleanup();
    }
  });

  it('writes nothing on --dry-run', () => {
    const s = sandbox();
    try {
      const r = s.run('--dry-run', 'runner');
      expect(r.status).toBe(0);
      expect(lines(r.stdout).slice(0, 2)).toEqual([
        'would install    adminforge-runner.service',
        'would install    adminforge-runner.service.d/hardening.conf',
      ]);
      expect(r.stdout).toContain('Dry run: nothing was written.');
      expect(s.files()).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  it.each([
    [['nginx'], /✗ unknown unit nginx/, 2],
    [['--force'], /✗ unknown option --force/, 2],
  ])('refuses %j', (args, message, status) => {
    const s = sandbox();
    try {
      const r = s.run(...args);
      expect(r.status).toBe(status);
      expect(r.stderr).toMatch(message);
      expect(s.files()).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  it('refuses a checkout that is not AdminForge', () => {
    const s = sandbox();
    try {
      const r = spawnSync('bash', [SCRIPT, '--checkout', tmpdir(), '--target', s.target], {
        encoding: 'utf8',
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('is not an AdminForge checkout');
      expect(s.files()).toEqual([]);
    } finally {
      s.cleanup();
    }
  });
});
