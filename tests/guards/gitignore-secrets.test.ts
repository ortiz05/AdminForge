import { execFileSync, spawnSync } from 'node:child_process';
import { repoRoot } from '../lib/repo';

// Env files, key material, env-file backups and database files never reach git (S-20): images are built from `git archive HEAD`
// (portal/deploy/kubernetes/build-images.sh), so whatever is committed ships. `adminforge db backup --plaintext` and
// `db import-postgres --to` can leave a SQLite database (with its -wal/-shm files) in a checkout; a certificate export
// or an editor's `.env.bak` is one `git add .` away. The repository's .gitignore must keep all of them out — checked
// against the patterns git really applies (`git check-ignore`), with the engineer's global excludes switched off.
const MUST_BE_IGNORED = [
  'client.key',
  'certs/automation.key',
  'automation.p12',
  'certs/automation.pfx',
  'automation.pem',
  'dev.env.bak',
  'dev.env.bak.1',
  'config/validation.env.bak-2026-10-21',
  'adminforge.db',
  'backups/adminforge.db',
  'adminforge.db-wal',
  'adminforge.db-shm',
  'legacy.sqlite',
  'legacy.sqlite3',
  'legacy.sqlite-wal',
  '.env',
  '.env.local',
  // AdminForge's own env files (~/.config/adminforge/<env>.env, .admin.env, .host.env) copied into a checkout
  'dev.env',
  'dev.admin.env',
  'config/validation.host.env',
  'legacy.db-journal',
  'certs/automation.jks',
  'id_rsa',
  'id_ecdsa',
  '.ssh/id_ed25519',
];

// Look-alikes that are source, documentation or the documented example and must stay committable.
const MUST_STAY_COMMITTABLE = [
  'config/example.env',
  'portal/apps/api/src/runs/sqlite-repository.ts',
  'portal/apps/api/src/db/client.ts',
  'portal/apps/api/src/datasources/env.ts',
  'tests/guards/sqlite-only.test.ts',
  'docs/adr/016-sqlite-on-a-persistent-volume.md',
  'portal/apps/web/src/routes/p.$key.tsx',
  'portal/apps/web/src/runs/keys.ts',
];

/** True when the repository's own ignore rules (not the engineer's global excludes) ignore the path. */
function ignored(rel: string): boolean {
  const r = spawnSync(
    'git',
    ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--quiet', '--no-index', rel],
    {
      cwd: repoRoot,
    },
  );
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore failed for ${rel}: ${r.stderr}`);
  return r.status === 0;
}

describe('.gitignore keeps env files, key material, env backups and databases out of git', () => {
  it.each(MUST_BE_IGNORED)('ignores %s', (rel) => {
    expect(ignored(rel)).toBe(true);
  });

  it.each(MUST_STAY_COMMITTABLE)('does not ignore %s', (rel) => {
    expect(ignored(rel)).toBe(false);
  });

  it('no tracked file matches an ignore pattern (a pattern added later never hides a committed secret)', () => {
    const tracked = execFileSync(
      'git',
      ['-c', 'core.excludesFile=/dev/null', 'ls-files', '--ignored', '--cached', '--exclude-standard', '-z'],
      { cwd: repoRoot },
    )
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    expect(tracked).toEqual([]);
  });
});
