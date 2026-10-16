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

// portal/deploy/backup/adminforge-backup.sh against a fake `docker` (never a real database): the dump leaves out the
// rows of the credential tables, the admin env file stays out of the configuration archive, and a dump that still
// holds credential rows is deleted and fails the backup.
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
  writeFileSync(path.join(config, 'dev.env'), 'AF_ENV_LABEL=example\n');
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
        ...extra,
      },
    });
  return {
    root,
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
      expect(r.stdout).toMatch(/^✓ backup .* not encrypted: set AF_BACKUP_GPG_RECIPIENT/m);
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
      expect(list).not.toContain('admin.env');
      expect(list).not.toContain('.bak');
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
});
