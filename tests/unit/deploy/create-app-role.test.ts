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
import { scramVerifier } from '../../../portal/deploy/db/scram.mjs';
import { parseEnvFile, repoRoot } from '../../lib/repo';

/**
 * The role statement a run sent: statement logging off for the session, a lock timeout, and the password only as a
 * SCRAM-SHA-256 verifier — one that PASSWORD really matches.
 */
function expectRoleStatement(sql: string, verb: 'CREATE' | 'ALTER') {
  expect(sql).toContain("SET log_statement = 'none';");
  expect(sql).toContain('SET log_min_duration_statement = -1;');
  expect(sql).toContain('SET log_min_error_statement = panic;');
  expect(sql).toContain("SET lock_timeout = '10s';");
  expect(sql).not.toContain(PASSWORD);
  const m = new RegExp(
    `${verb} ROLE adminforge_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '(SCRAM-SHA-256\\$4096:([^$]+)\\$[^']+)';`,
  ).exec(sql);
  expect(m).not.toBeNull();
  expect(scramVerifier(PASSWORD, { salt: Buffer.from(m![2]!, 'base64') })).toBe(m![1]);
}

// portal/deploy/db/create-app-role.sh against a fake `docker` and `openssl` (never a real database): how it reads the
// env file and the owner URL, which SQL it sends (on stdin, never on a command line), and how it rewrites the two
// database URLs. Values are synthetic.
const SCRIPT = path.join(repoRoot, 'portal/deploy/db/create-app-role.sh');
const PASSWORD = 'ab'.repeat(32);
const OWNER_URL = 'postgres://adminforge:owner-secret@127.0.0.1:55432/adminforge';

// Logs each call's arguments; answers the "does the role exist" query; keeps each piped SQL script.
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/calls.log"
case "$*" in
  *"-Atc select 1 from pg_roles"*) [ "\${FAKE_ROLE_EXISTS:-}" = 1 ] && echo 1; exit 0 ;;
esac
n=$(ls "$FAKE_DIR" | grep -c '^stdin\\.' || true)
cat > "$FAKE_DIR/stdin.$((n + 1))"
exit 0
`;
const FAKE_OPENSSL = `#!/usr/bin/env bash
[ "$*" = "rand -hex 32" ] || exit 9
echo "$FAKE_PASSWORD"
`;

function sandbox(envFile: string | null) {
  const root = mkdtempSync(path.join(tmpdir(), 'af-app-role-'));
  const bin = path.join(root, 'bin');
  const fake = path.join(root, 'fake');
  mkdirSync(bin);
  mkdirSync(fake);
  for (const [name, body] of [
    ['docker', FAKE_DOCKER],
    ['openssl', FAKE_OPENSSL],
  ] as const) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  const file = path.join(root, 'dev.host.env');
  if (envFile !== null) writeFileSync(file, envFile, { mode: 0o600 });
  const run = (args: string[] = [], extra: Record<string, string> = {}) =>
    spawnSync('bash', [SCRIPT, file, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: root,
        FAKE_DIR: fake,
        FAKE_PASSWORD: PASSWORD,
        ...extra,
      },
    });
  const sql = () =>
    readdirSync(fake)
      .filter((f) => f.startsWith('stdin.'))
      .sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
      .map((f) => readFileSync(path.join(fake, f), 'utf8'));
  const calls = () =>
    existsSync(path.join(fake, 'calls.log'))
      ? readFileSync(path.join(fake, 'calls.log'), 'utf8').trim().split('\n')
      : [];
  return {
    file,
    run,
    sql,
    calls,
    env: () => parseEnvFile(file),
    /** The owner file next to the env file (dev.host.owner.env): the services never read it. */
    ownerFile: path.join(root, 'dev.host.owner.env'),
    owner: () => parseEnvFile(path.join(root, 'dev.host.owner.env')),
    text: () => readFileSync(file, 'utf8'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const hasTools = ['bash', 'sed', 'grep', 'mktemp'].every(
  (t) => spawnSync('sh', ['-c', `command -v ${t}`]).status === 0,
);

describe.skipIf(!hasTools)('create-app-role.sh', () => {
  it('creates the role, grants row access and points DATABASE_URL at it (owner kept for migrations)', () => {
    const s = sandbox(
      `# synthetic host overlay\nAF_ENV_LABEL=example\nDATABASE_URL=${OWNER_URL}\nAF_NOTE=a=b\n`,
    );
    try {
      const r = s.run();
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(
        `✓ adminforge_app ready on adminforge (row access, audit log insert/select only); ${s.file}: DATABASE_URL → adminforge_app; ${s.ownerFile}: DATABASE_MIGRATION_URL → owner`,
      );
      // Every statement goes through the container's superuser over its socket; no secret on a command line.
      for (const call of s.calls()) {
        expect(call).toMatch(
          /^exec -i adminforge-dev-postgres-1 psql -v ON_ERROR_STOP=1 -q -U adminforge -d adminforge/,
        );
        expect(call).not.toContain(PASSWORD);
        expect(call).not.toContain('owner-secret');
      }
      const [create, grants] = s.sql();
      expectRoleStatement(create!, 'CREATE');
      // Both scripts run as one transaction each.
      expect(s.calls().filter((c) => / -1$/.test(c))).toHaveLength(2);
      expect(grants).not.toContain('{{');
      expect(grants).toContain('GRANT CONNECT ON DATABASE "adminforge" TO adminforge_app;');
      expect(grants).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "adminforge" IN SCHEMA public');
      expect(grants).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM adminforge_app;');
      expect(grants).toContain('CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION adminforge_app;');
      // The env file keeps everything else and gets the services' URL; the owner's goes to the owner file. Both private.
      expect(s.env()).toEqual({
        AF_ENV_LABEL: 'example',
        AF_NOTE: 'a=b',
        DATABASE_URL: `postgres://adminforge_app:${PASSWORD}@127.0.0.1:55432/adminforge`,
      });
      expect(s.owner()).toEqual({ DATABASE_MIGRATION_URL: OWNER_URL });
      expect(s.text()).toContain('# synthetic host overlay\n');
      expect(statSync(s.file).mode & 0o777).toBe(0o600);
      expect(statSync(s.ownerFile).mode & 0o777).toBe(0o600);
      expect(r.stdout).not.toContain(PASSWORD);
    } finally {
      s.cleanup();
    }
  });

  it('is idempotent: an existing role and app URL keep their password', () => {
    const appUrl = 'postgres://adminforge_app:app-secret@127.0.0.1:55432/adminforge';
    const s = sandbox(`DATABASE_URL=${appUrl}\nDATABASE_MIGRATION_URL=${OWNER_URL}\n`);
    try {
      const r = s.run([], { FAKE_ROLE_EXISTS: '1' });
      expect(r.status).toBe(0);
      const sql = s.sql();
      expect(sql).toHaveLength(1);
      expect(sql[0]).toContain('GRANT CONNECT ON DATABASE');
      expect(sql.join('')).not.toMatch(/CREATE ROLE|ALTER ROLE/);
      // An older layout's DATABASE_MIGRATION_URL moves from the env file to the owner file.
      expect(s.env()).toEqual({ DATABASE_URL: appUrl });
      expect(s.owner()).toEqual({ DATABASE_MIGRATION_URL: OWNER_URL });
    } finally {
      s.cleanup();
    }
  });

  it('sets a new password with ALTER ROLE on --rotate, or when DATABASE_URL does not use the role yet', () => {
    const appUrl = 'postgres://adminforge_app:app-secret@127.0.0.1:55432/adminforge';
    for (const [env, args] of [
      [`DATABASE_URL=${appUrl}\nDATABASE_MIGRATION_URL=${OWNER_URL}\n`, ['--rotate']],
      [`DATABASE_URL=${OWNER_URL}\n`, []],
    ] as const) {
      const s = sandbox(env);
      try {
        expect(s.run([...args], { FAKE_ROLE_EXISTS: '1' }).status).toBe(0);
        expectRoleStatement(s.sql()[0]!, 'ALTER');
        expect(s.env().DATABASE_URL).toBe(`postgres://adminforge_app:${PASSWORD}@127.0.0.1:55432/adminforge`);
        expect(s.owner().DATABASE_MIGRATION_URL).toBe(OWNER_URL);
      } finally {
        s.cleanup();
      }
    }
  });

  it('takes the owner, database and host from DATABASE_MIGRATION_URL before DATABASE_URL', () => {
    const owner = 'postgres://af_owner:owner-secret@db.internal:6543/adminforge_dev?sslmode=disable';
    const s = sandbox(
      `DATABASE_URL=postgres://someone:x@elsewhere:5432/other\nDATABASE_MIGRATION_URL=${owner}\n`,
    );
    try {
      expect(s.run().status).toBe(0);
      // SQL runs as the container superuser on the owner's database; the owner gets the default privileges.
      expect(s.calls()[0]).toMatch(/ -U adminforge -d adminforge_dev -Atc /);
      const grants = s.sql()[1]!;
      expect(grants).toContain('GRANT CONNECT ON DATABASE "adminforge_dev" TO adminforge_app;');
      expect(grants).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "af_owner"');
      expect(s.env().DATABASE_URL).toMatch(
        new RegExp(`^postgres://adminforge_app:${PASSWORD}@db\\.internal:6543/adminforge_dev`),
      );
      expect(s.owner().DATABASE_MIGRATION_URL).toBe(owner);
    } finally {
      s.cleanup();
    }
  });

  it("prefers the owner file's DATABASE_MIGRATION_URL (written by db:harden) to the env file", () => {
    const owner = 'postgres://adminforge_owner:owner-secret@127.0.0.1:55432/adminforge';
    const s = sandbox(`DATABASE_URL=${OWNER_URL}\nDATABASE_MIGRATION_URL=${OWNER_URL}\n`);
    try {
      writeFileSync(s.ownerFile, `# kept\nDATABASE_MIGRATION_URL=${owner}\nOTHER=1\n`, { mode: 0o600 });
      expect(s.run().status).toBe(0);
      expect(s.calls()[0]).toMatch(/ -U adminforge -d adminforge -Atc /);
      expect(s.sql()[1]).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "adminforge_owner"');
      expect(s.owner()).toEqual({ DATABASE_MIGRATION_URL: owner, OTHER: '1' });
      expect(s.env()).not.toHaveProperty('DATABASE_MIGRATION_URL');
    } finally {
      s.cleanup();
    }
  });

  it('uses AF_DB_CONTAINER, else AF_PG_CONTAINER, else the default from portal/deploy/defaults.env', () => {
    for (const [extra, container] of [
      [{ AF_DB_CONTAINER: 'pg-a' }, 'pg-a'],
      [{ AF_PG_CONTAINER: 'pg-b' }, 'pg-b'],
      [{ AF_DB_CONTAINER: 'pg-a', AF_PG_CONTAINER: 'pg-b' }, 'pg-a'],
    ] as const) {
      const s = sandbox(`DATABASE_URL=${OWNER_URL}\n`);
      try {
        expect(s.run([], extra).status).toBe(0);
        expect(s.calls().every((c) => c.startsWith(`exec -i ${container} psql `))).toBe(true);
      } finally {
        s.cleanup();
      }
    }
  });

  it.each([
    [null, /✗ .*dev\.host\.env not found/],
    ['AF_ENV_LABEL=example\n', /✗ .* has no DATABASE_URL/],
    [
      'DATABASE_MIGRATION_URL=postgres://adminforge_app:x@127.0.0.1:55432/adminforge\n',
      /✗ DATABASE_MIGRATION_URL must use the owner, not adminforge_app/,
    ],
  ])('refuses %j without touching the database or the file', (env, message) => {
    const s = sandbox(env);
    try {
      const r = s.run();
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(message);
      expect(s.calls()).toEqual([]);
      if (env !== null) expect(s.text()).toBe(env);
    } finally {
      s.cleanup();
    }
  });
});
