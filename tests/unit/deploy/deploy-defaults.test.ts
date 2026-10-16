import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { missingLocalKeys } from '@adminforge/api/src/scripts/init-local';
import { committableFiles, parseEnvFile, readText, repoRoot } from '../../lib/repo';

// portal/deploy/defaults.env is the one place for the local Postgres's container name, owner role, database and port.
// Compose and the deploy shell scripts read it; what can't read it (config/example.env, init:local, the docs) must
// agree with it — these tests say where to look when a value changes.
const DEFAULTS = parseEnvFile(path.join(repoRoot, 'portal/deploy/defaults.env'));
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('deploy defaults', () => {
  it('define the container, owner role, database and port', () => {
    expect(Object.keys(DEFAULTS).sort()).toEqual([
      'AF_PG_CONTAINER',
      'AF_PG_DATABASE',
      'AF_PG_PORT',
      'AF_PG_USER',
    ]);
    expect(DEFAULTS.AF_PG_PORT).toMatch(/^\d+$/);
  });

  it('are what docker-compose.dev.yml interpolates, and name its container', () => {
    const compose = read('portal/deploy/docker-compose.dev.yml');
    const project = /^name: (\S+)$/m.exec(compose)?.[1];
    expect(`${project}-postgres-1`).toBe(DEFAULTS.AF_PG_CONTAINER);
    for (const key of ['AF_PG_USER', 'AF_PG_DATABASE', 'AF_PG_PORT']) expect(compose).toContain(`\${${key}`);
    const yaml = compose.replace(/^\s*#.*$/gm, '');
    expect(yaml).not.toContain(DEFAULTS.AF_PG_PORT!);
    expect(yaml).not.toMatch(/POSTGRES_(USER|DB): [a-z]/);
  });

  it('are passed to compose first by pnpm db:up and db:down, so the env file can override them', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    for (const name of ['db:up', 'db:down']) {
      expect(scripts[name]).toMatch(
        /^docker compose --env-file portal\/deploy\/defaults\.env --env-file "\$\{ADMINFORGE_ENV_FILE:-[^}]+\}" -f portal\/deploy\/docker-compose\.dev\.yml /,
      );
    }
  });

  it('are loaded by the deploy shell scripts instead of literals', () => {
    for (const script of [
      'portal/deploy/backup/adminforge-backup.sh',
      'portal/deploy/db/create-app-role.sh',
    ]) {
      const text = read(script);
      expect(text).toContain('. "$DEPLOY_DIR/lib/defaults.sh"');
      expect(text).toContain('af_load_deploy_defaults');
      expect(text).not.toContain(DEFAULTS.AF_PG_CONTAINER!);
    }
  });

  it('match the DATABASE_URL of config/example.env and of init:local', () => {
    const expectUrl = (raw: string) => {
      const url = new URL(raw);
      expect([url.username, url.hostname, url.port, url.pathname]).toEqual([
        DEFAULTS.AF_PG_USER,
        '127.0.0.1',
        DEFAULTS.AF_PG_PORT,
        `/${DEFAULTS.AF_PG_DATABASE}`,
      ]);
    };
    expectUrl(parseEnvFile(path.join(repoRoot, 'config/example.env')).DATABASE_URL!);
    expectUrl(missingLocalKeys({}).DATABASE_URL!);
  });

  it('match the container name and port the docs give', () => {
    const docs = committableFiles().filter(
      (f) => f.endsWith('.md') && f !== 'CHANGELOG.md' && !f.startsWith('docs/plans/'),
    );
    const containers = new Set<string>();
    const ports = new Set<string>();
    for (const f of docs) {
      const text = readText(f) ?? '';
      for (const m of text.matchAll(/\b([a-z][\w-]*-postgres-1)\b/g)) containers.add(`${m[1]} (${f})`);
      // Postgres lines; http://127.0.0.1:<port> is an HTTP service, not the database.
      for (const line of text.split('\n').filter((l) => /postgres/i.test(l)))
        for (const m of line.matchAll(/(?<!\/\/)127\.0\.0\.1:(\d+)/g)) ports.add(`${m[1]} (${f})`);
    }
    expect(containers.size).toBeGreaterThan(0);
    expect([...containers].filter((c) => !c.startsWith(`${DEFAULTS.AF_PG_CONTAINER} `))).toEqual([]);
    expect(ports.size).toBeGreaterThan(0);
    expect([...ports].filter((p) => !p.startsWith(`${DEFAULTS.AF_PG_PORT} `))).toEqual([]);
  });

  it('are exported to the shell scripts unless the environment sets them', () => {
    const load = (env: Record<string, string>) =>
      spawnSync(
        'bash',
        ['-c', '. portal/deploy/lib/defaults.sh && af_load_deploy_defaults && env | grep "^AF_PG_" | sort'],
        { cwd: repoRoot, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } },
      ).stdout;
    expect(load({})).toBe(
      Object.entries(DEFAULTS)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}\n`)
        .join(''),
    );
    expect(load({ AF_PG_PORT: '6000', AF_PG_CONTAINER: '' })).toContain('AF_PG_PORT=6000\n');
    expect(load({ AF_PG_CONTAINER: '' })).toContain(`AF_PG_CONTAINER=${DEFAULTS.AF_PG_CONTAINER}\n`);
  });
});
