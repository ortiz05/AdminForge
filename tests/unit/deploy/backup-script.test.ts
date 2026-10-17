import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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

// portal/deploy/backup/adminforge-backup.sh against a fake `docker` (never a real database): it refuses to run
// unencrypted unless plaintext is explicitly allowed, the dump leaves out the rows of the credential tables, the admin
// and owner env files (and owner keys in an older env file) stay out of the configuration archive, and a dump that still
// holds credential rows is deleted and fails the backup. The service account's report files are archived when this user
// can read them; when it can't, the rest is backed up and the run fails naming the fix.
const SCRIPT = path.join(repoRoot, 'portal/deploy/backup/adminforge-backup.sh');
const CREDENTIAL_TABLES = ['public.sessions', 'public.preauth', 'public.token_cache'];

const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *pg_dump*) printf 'PGDMP-fake-dump\\n' ;;
  *"pg_restore --list"*)
    cat > /dev/null
    printf ';\\n; Archive created by a fake pg_dump\\n'
    printf '3401; 0 16404 TABLE DATA public audit_events adminforge\\n'
    printf '3402; 0 16420 TABLE DATA public audit_events_archive adminforge\\n'
    printf '3403; 0 16430 TABLE public token_cache adminforge\\n'
    [ -n "$FAKE_LEAK" ] && printf '3404; 0 16431 TABLE DATA public %s adminforge\\n' "$FAKE_LEAK"
    ;;
esac
exit 0
`;

function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'af-backup-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const config = path.join(home, '.config', 'adminforge');
  mkdirSync(config, { recursive: true });
  mkdirSync(bin);
  writeFileSync(
    path.join(config, 'dev.env'),
    'AF_ENV_LABEL=example\nPOSTGRES_PASSWORD=example-superuser\nDATABASE_URL=postgres://adminforge_dev:x@127.0.0.1:55432/adminforge_dev\n',
  );
  writeFileSync(
    path.join(config, 'dev.host.env'),
    'DATABASE_URL=postgres://adminforge_app:y@127.0.0.1:55432/adminforge\nDATABASE_MIGRATION_URL=postgres://adminforge:owner@127.0.0.1:55432/adminforge\n',
  );
  writeFileSync(
    path.join(config, 'dev.host.owner.env'),
    'DATABASE_MIGRATION_URL=postgres://adminforge_owner:z@h/a\n',
  );
  // A half-written copy create-app-role.sh may leave, a subdirectory, a dotfile and another text file with an owner key.
  writeFileSync(
    path.join(config, 'dev.host.owner.env.Ab12Cd'),
    'DATABASE_MIGRATION_URL=postgres://x:leak@h/a\n',
  );
  mkdirSync(path.join(config, 'certs'));
  writeFileSync(path.join(config, 'certs', 'automation.pem'), '-----BEGIN CERTIFICATE-----\nexample\n');
  writeFileSync(path.join(config, '.keep'), '');
  writeFileSync(path.join(config, 'notes.conf'), 'export POSTGRES_PASSWORD=leak\nkept=1\n');
  writeFileSync(path.join(config, 'dev.admin.env'), 'AF_PROVISIONER_CLIENT_SECRET=example\n');
  writeFileSync(path.join(config, 'dev.env.bak1'), 'old copy\n');
  writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(path.join(bin, 'docker'), 0o755);
  const log = path.join(root, 'docker.log');
  const backups = path.join(root, 'backups');
  const run = (extra: Record<string, string> = {}) =>
    spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: home,
        AF_BACKUP_DIR: backups,
        FAKE_DOCKER_LOG: log,
        AF_BACKUP_ALLOW_PLAINTEXT: '1',
        AF_BACKUP_STATE_DIR: path.join(root, 'var-lib-adminforge'),
        ...extra,
      },
    });
  return {
    root,
    state: path.join(root, 'var-lib-adminforge'),
    backups,
    run,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const hasTools = ['bash', 'tar', 'shred'].every(
  (t) => spawnSync('sh', ['-c', `command -v ${t}`]).status === 0,
);

describe.skipIf(!hasTools)('adminforge-backup.sh', () => {
  it('dumps the database without the rows of the credential tables', () => {
    const s = sandbox();
    try {
      const r = s.run();
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const dump = s.calls().find((c) => c.includes('pg_dump'))!;
      expect(dump).toMatch(/^exec adminforge-dev-postgres-1 pg_dump -U adminforge -Fc .* adminforge$/);
      for (const t of CREDENTIAL_TABLES) expect(dump.split(' ')).toContain(`--exclude-table-data=${t}`);
      expect(r.stdout).toMatch(
        /^✓ backup .* NOT encrypted \(AF_BACKUP_ALLOW_PLAINTEXT=1\): set AF_BACKUP_GPG_RECIPIENT/m,
      );
    } finally {
      s.cleanup();
    }
  });

  it('keeps the admin env file and stray copies out, and the backup private', () => {
    const s = sandbox();
    try {
      expect(s.run().status).toBe(0);
      const [stamp] = readdirSync(s.backups);
      const dest = path.join(s.backups, stamp!);
      expect(statSync(s.backups).mode & 0o777).toBe(0o700);
      expect(statSync(dest).mode & 0o777).toBe(0o700);
      expect(readdirSync(dest).sort()).toEqual(['adminforge.dump', 'config.tgz']);
      for (const f of readdirSync(dest)) expect(statSync(path.join(dest, f)).mode & 0o777).toBe(0o600);
      const list = spawnSync('tar', ['-tzf', path.join(dest, 'config.tgz')], { encoding: 'utf8' }).stdout;
      expect(list).toContain('adminforge/dev.env');
      expect(list).toContain('adminforge/dev.host.env');
      expect(list).not.toContain('admin.env');
      expect(list).not.toContain('owner.env');
      expect(list).not.toContain('.bak');
      expect(list).not.toContain('config-stage');
      expect(list).not.toContain('Ab12Cd');
      expect(list).toContain('adminforge/certs/automation.pem');
      expect(list).toContain('adminforge/.keep');
      expect(existsSync(path.join(dest, '.config-stage'))).toBe(false);
      // Owner keys an older layout keeps in the env files are left out; the rest of each file is kept.
      const extract = (name: string) =>
        spawnSync('tar', ['-xzOf', path.join(dest, 'config.tgz'), `adminforge/${name}`], { encoding: 'utf8' })
          .stdout;
      expect(extract('dev.env')).not.toContain('POSTGRES_PASSWORD');
      expect(extract('dev.env')).toContain('AF_ENV_LABEL=example');
      expect(extract('dev.host.env')).not.toContain('DATABASE_MIGRATION_URL');
      expect(extract('dev.host.env')).toContain('DATABASE_URL=postgres://adminforge_app');
      expect(extract('notes.conf')).toBe('kept=1\n');
      expect(extract('certs/automation.pem')).toContain('BEGIN CERTIFICATE');
    } finally {
      s.cleanup();
    }
  });

  it('refuses to run unencrypted unless plaintext is allowed', () => {
    const s = sandbox();
    try {
      const r = s.run({ AF_BACKUP_ALLOW_PLAINTEXT: '' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/backups are encrypted: set AF_BACKUP_GPG_RECIPIENT/);
      expect(s.calls()).toEqual([]);
      expect(existsSync(s.backups)).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  it('deletes a dump that still holds credential rows and fails', () => {
    for (const leak of ['token_cache', 'sessions', 'preauth']) {
      const s = sandbox();
      try {
        const r = s.run({ FAKE_LEAK: leak });
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(`the dump held rows of public.${leak} (credentials)`);
        const [stamp] = readdirSync(s.backups);
        expect(readdirSync(path.join(s.backups, stamp!))).toEqual([]);
      } finally {
        s.cleanup();
      }
    }
  });

  it('archives the service account’s report files, and fails naming the fix when it can’t read them', () => {
    const s = sandbox();
    try {
      mkdirSync(path.join(s.state, 'artifacts/reports.x'), { recursive: true });
      writeFileSync(path.join(s.state, 'artifacts/reports.x/2026-10-17.csv'), 'a,b\n');
      const ok = s.run();
      expect(ok.status).toBe(0);
      const [stamp] = readdirSync(s.backups);
      const dest = path.join(s.backups, stamp!);
      expect(readdirSync(dest).sort()).toEqual(['adminforge.dump', 'config.tgz', 'state.tgz']);
      const list = spawnSync('tar', ['-tzf', path.join(dest, 'state.tgz')], { encoding: 'utf8' }).stdout;
      expect(list).toContain('artifacts/reports.x/2026-10-17.csv');

      if (process.getuid?.() !== 0) {
        chmodSync(path.join(s.state, 'artifacts/reports.x/2026-10-17.csv'), 0o000);
        const gap = s.run();
        expect(gap.status).toBe(1);
        expect(gap.stdout).toMatch(/^✓ backup /m);
        expect(gap.stderr).toMatch(/report files in .* were not backed up: .* sudo usermod -aG adminforge /);
      }
    } finally {
      s.cleanup();
    }
  });
});
