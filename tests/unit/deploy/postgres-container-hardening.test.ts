import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoRoot } from '../../lib/repo';

// The local Postgres container (portal/deploy/docker-compose.dev.yml) and the pg_hba.conf rule that keeps the
// bootstrap superuser off TCP (portal/deploy/db/initdb/10-reject-superuser-tcp.sh) — docs/operations.md → Postgres
// hardening.
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');
const compose = read('portal/deploy/docker-compose.dev.yml').replace(/^\s*#.*$/gm, '');
const SNIPPET = path.join(repoRoot, 'portal/deploy/db/initdb/10-reject-superuser-tcp.sh');

describe('docker-compose.dev.yml', () => {
  it('pins the image by digest', () => {
    expect(compose).toMatch(/image: postgres:18-alpine@sha256:[0-9a-f]{64}\n/);
  });

  it('logs connections, DDL, lock waits and slow statements, and rotates the container log', () => {
    for (const flag of [
      'log_connections=receipt,authentication,authorization',
      'log_disconnections=on',
      'log_statement=ddl',
      'log_lock_waits=on',
      'log_min_duration_statement=2s',
      'log_parameter_max_length=0',
      'log_parameter_max_length_on_error=0',
      "'log_line_prefix=%m [%p] %u@%d %a %h '",
    ])
      expect(compose).toContain(`- ${flag}`);
    expect(compose).toMatch(
      /logging:\n\s+driver: json-file\n\s+options:\n\s+max-size: 10m\n\s+max-file: '5'/,
    );
  });

  it('runs without privilege escalation and within memory and process limits', () => {
    expect(compose).toContain('- no-new-privileges:true');
    expect(compose).toMatch(/mem_limit: \d+g/);
    expect(compose).toMatch(/pids_limit: \d+/);
  });

  it('keeps the loopback-only port, and gives a NEW cluster password TCP auth and the superuser rule', () => {
    expect(compose).toMatch(/- '127\.0\.0\.1:\$\{AF_PG_PORT/);
    expect(compose).toContain('POSTGRES_INITDB_ARGS: --auth-host=scram-sha-256');
    expect(compose).toContain('- ./db/initdb:/docker-entrypoint-initdb.d:ro');
    // An existing cluster ignores POSTGRES_PASSWORD, so compose no longer requires it (it lives in the owner file).
    expect(compose).toContain('POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-}');
    expect(statSync(SNIPPET).mode & 0o111).not.toBe(0);
  });
});

const hasTools = ['sh', 'awk', 'grep'].every((t) => spawnSync('sh', ['-c', `command -v ${t}`]).status === 0);

describe.skipIf(!hasTools)('10-reject-superuser-tcp.sh', () => {
  const HBA = [
    '# TYPE  DATABASE  USER  ADDRESS  METHOD',
    'local   all       all            trust',
    'host    all       all   127.0.0.1/32  scram-sha-256',
    'host all all all scram-sha-256',
    '',
  ].join('\n');
  const run = (hba: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'af-hba-'));
    try {
      writeFileSync(path.join(dir, 'pg_hba.conf'), hba, { mode: 0o600 });
      const go = () =>
        spawnSync('sh', [SNIPPET], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PGDATA: dir, POSTGRES_USER: 'adminforge' },
        });
      const first = go();
      const once = readFileSync(path.join(dir, 'pg_hba.conf'), 'utf8');
      const second = go();
      return {
        first,
        second,
        once,
        twice: readFileSync(path.join(dir, 'pg_hba.conf'), 'utf8'),
        mode: statSync(path.join(dir, 'pg_hba.conf')).mode & 0o777,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('rejects the superuser before the first host rule, once, keeping the file private', () => {
    const r = run(HBA);
    expect([r.first.status, r.first.stdout, r.second.status]).toEqual([0, '', 0]);
    const lines = r.once.split('\n');
    const reject = lines.indexOf('host all adminforge all reject');
    expect(reject).toBeGreaterThan(-1);
    expect(lines[reject + 1]).toBe('host replication adminforge all reject');
    expect(reject).toBeLessThan(lines.findIndex((l) => l.startsWith('host    all       all   127.0.0.1/32')));
    expect(r.twice).toBe(r.once);
    expect(r.mode).toBe(0o600);
    // Local socket access (docker exec) is untouched.
    expect(r.once).toContain('local   all       all            trust');
  });

  it('appends the rule when the file has no host rules yet', () => {
    const r = run('local all all trust\n');
    expect(r.once.trim().split('\n')).toEqual([
      'local all all trust',
      'host all adminforge all reject',
      'host replication adminforge all reject',
    ]);
  });
});
