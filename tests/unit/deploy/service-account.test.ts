import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoRoot } from '../../lib/repo';

// portal/deploy/install-service-account.sh (Postgres finding C1: the services leave the owner's docker/sudo account).
// The dry-run plan and its refusals, the configuration it copies (allow-listed keys only), releases, pruning and
// rollback, and the hardening of the system units. With AF_SA_PREFIX (never as root) the script writes under a scratch
// root and skips what needs root (accounts, ownership, systemctl, nft), so --apply/--release/--rollback run here.
const SCRIPT = path.join(repoRoot, 'portal/deploy/install-service-account.sh');
const SECRET = 'sentinel-secret-value-7f3a';
const URL_VALUE = 'https://sentinel-host.example.test:8443';

interface Options {
  dirty?: boolean;
  stale?: boolean;
  overlay?: string;
  account?: { groups: string };
  uid?: number;
  extraBase?: string;
  extraOverride?: string;
}

function sandbox(opts: Options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'af-svc-'));
  const checkout = path.join(root, 'checkout');
  const home = path.join(root, 'home');
  const prefix = path.join(root, 'prefix');
  const bin = path.join(root, 'bin');
  for (const d of [checkout, home, prefix, bin]) mkdirSync(d, { recursive: true });
  const write = (rel: string, text: string, base = checkout) => {
    mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    writeFileSync(path.join(base, rel), text);
  };
  const git = (...args: string[]) =>
    spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-C', checkout, ...args], {
      encoding: 'utf8',
    });

  // A checkout committed to git, then built.
  write('package.json', '{"name":"adminforge"}\n');
  write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  write(
    'config/example.env',
    [
      'AF_TENANT_ID=',
      'AF_READ_CLIENT_SECRET=',
      'DATABASE_URL=',
      'AF_AUTOMATION_CERT_PATH=',
      'CONTENT_DIR=',
      'AF_TEST_USER_PASSWORD=',
      'RUNNER_SHARED_KEY=',
      'RUNNER_PORT=3101',
      '',
    ].join('\n'),
  );
  write('portal/apps/api/package.json', '{"dependencies":{"@adminforge/schemas":"workspace:*"}}\n');
  write('portal/apps/scheduler/package.json', '{"dependencies":{"@adminforge/api":"workspace:*"}}\n');
  write('portal/apps/runner/package.json', '{}\n');
  write('portal/apps/web/package.json', '{"dependencies":{"@adminforge/schemas":"workspace:*"}}\n');
  write('portal/packages/schemas/package.json', '{}\n');
  write('.gitignore', 'dist/\nnode_modules/\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const build = () => {
    for (const f of [
      'portal/apps/api/dist/main.js',
      'portal/apps/api/dist/worker.js',
      'portal/apps/scheduler/dist/main.js',
      'portal/apps/runner/dist/main.js',
      'portal/apps/web/dist/index.html',
    ]) {
      write(f, '// built\n');
      const t = opts.stale ? new Date(2000, 0, 1) : new Date(Date.now() + 5_000);
      utimesSync(path.join(checkout, f), t, t);
    }
    mkdirSync(path.join(checkout, 'node_modules'), { recursive: true });
  };
  build();
  if (opts.dirty) write('portal/apps/api/src.ts', 'changed\n');

  // The owner's configuration, user-unit drop-ins, runtime and report files.
  const cfg = path.join(home, '.config/adminforge');
  write(
    'dev.env',
    [
      `AF_READ_CLIENT_SECRET=${SECRET}`,
      `AF_TEST_USER_PASSWORD=${SECRET}`,
      `DATABASE_URL=postgres://adminforge_dev:${SECRET}@127.0.0.1:55432/adminforge_dev`,
      'AF_TENANT_ID=x',
      `UNDOCUMENTED_KEY=${SECRET}`,
      opts.extraBase ?? '',
      '',
    ].join('\n'),
    cfg,
  );
  write('dev.host.env', `DATABASE_URL=postgres://adminforge_app:${SECRET}@127.0.0.1:55432/adminforge\n`, cfg);
  write(
    'dev.runner.env',
    `RUNNER_SHARED_KEY=${SECRET}\nRUNNER_PORT=3102\nLOG_LEVEL=info\nAF_TENANT_ID=x\n`,
    cfg,
  );
  write('dev.admin.env', `AF_PROVISIONER_CLIENT_SECRET=${SECRET}\n`, cfg);
  write('dev.host.owner.env', `DATABASE_MIGRATION_URL=${SECRET}\n`, cfg);
  write('automation.pem', 'synthetic certificate placeholder\n', cfg);
  const units = path.join(home, '.config/systemd/user');
  write(
    'adminforge-api.service.d/override.conf',
    [
      '[Service]',
      `Environment=PATH=${home}/.nvm/bin:%h/.local/bin:/usr/bin:/bin`,
      'Environment=NODE_ENV=production',
      'Environment=API_PORT=3300',
      `Environment=PUBLIC_BASE_URL=${URL_VALUE}`,
      `Environment=ADMINFORGE_ENV_OVERLAY=${opts.overlay ?? 'host'}`,
      'Environment=NODE_EXTRA_CA_CERTS=%h/.local/share/caddy/root.crt',
      'Environment=SOMETHING_ELSE=1',
      opts.extraOverride ?? '',
      '',
    ].join('\n'),
    units,
  );
  write('adminforge-api.service.d/hardening.conf', '[Service]\nNoNewPrivileges=yes\n', units);
  write(
    'adminforge-runner.service.d/override.conf',
    '[Service]\nEnvironmentFile=%h/.config/adminforge/dev.runner.env\nEnvironment=PWSH_PATH=%h/.local/bin/pwsh\n',
    units,
  );
  write('.local/share/caddy/root.crt', '-----BEGIN CERTIFICATE-----\n', home);
  write('.local/share/adminforge/artifacts/reports.x/2026-10-17.csv', 'a,b\n', home);
  write('.local/share/powershell/7.6.7/pwsh', '#!/bin/sh\n', home);
  write('.local/share/powershell/7.6.7/pwsh.dll', 'dll\n', home);
  mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  symlinkSync(path.join(home, '.local/share/powershell/7.6.7/pwsh'), path.join(home, '.local/bin/pwsh'));
  write('.nvm/bin/node', '#!/bin/sh\necho v24.13.0\n', home);
  chmodSync(path.join(home, '.nvm/bin/node'), 0o755);

  // Stub commands: getent and id answer for the service accounts and the owner.
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  stub(
    'getent',
    opts.account
      ? `[ "$1" = passwd ] && [ "$2" = adminforge ] && echo "adminforge:x:999:999::/var/lib/adminforge:/usr/sbin/nologin" && exit 0; exit 2`
      : 'exit 2',
  );
  stub(
    'id',
    `case "$1" in -u) echo ${opts.uid ?? 1000} ;; -nG) echo "${opts.account?.groups ?? ''}" ;; *) /usr/bin/id "$@" ;; esac`,
  );

  const run = (...args: string[]) =>
    spawnSync('bash', [SCRIPT, '--checkout', checkout, '--owner', 'avery', ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: home,
        AF_SA_OWNER_HOME: home,
        AF_SA_PREFIX: prefix,
      },
    });
  const at = (rel: string) => path.join(prefix, rel);
  const commit = (msg: string) => {
    write(`portal/apps/api/change-${msg}.ts`, msg);
    git('add', '-A');
    git('commit', '-qm', msg);
    build();
  };
  return {
    run,
    at,
    home,
    commit,
    written: () => (readdirSync(prefix, { recursive: true }) as string[]).length,
    releases: () => readdirSync(at('opt/adminforge/releases')).sort(),
    current: () => readlinkSync(at('opt/adminforge/current')),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('install-service-account.sh --dry-run', () => {
  it('prints the whole plan, writes nothing and never prints a value', () => {
    const s = sandbox();
    try {
      const r = s.run('--firewall');
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const out = r.stdout;
      expect(out).toContain(
        'would create system user adminforge (group adminforge, shell /usr/sbin/nologin)',
      );
      expect(out).toContain('would create system user adminforge-runner (group adminforge-runner');
      expect(out).toContain('would add avery to group adminforge');
      expect(out).toContain('would copy node v24.13.0 → /opt/adminforge/runtime/node-v24.13.0/bin/node');
      expect(out).toContain('would copy PowerShell 7.6.7 → /opt/adminforge/runtime/powershell-7.6.7');
      expect(out).toMatch(/would rsync the checkout → \/opt\/adminforge\/releases\/[0-9a-f]{12}\.<time>/);
      // Allow-listed keys only: undocumented, test-account and overlay-replaced keys are named, never shown.
      expect(out).toContain(
        'would copy dev.env (0640 root:adminforge) — leaving out: AF_TEST_USER_PASSWORD DATABASE_URL UNDOCUMENTED_KEY',
      );
      expect(out).toContain(
        'would copy dev.runner.env (0600 root:root, read by systemd for the runner) — leaving out: AF_TENANT_ID',
      );
      expect(out).toContain('never copied: dev.admin.env, dev.owner.env, dev.host.owner.env');
      expect(out).toContain('with 1 report file(s) imported');
      expect(out).toMatch(
        /adminforge-api\.service \(User=adminforge\) \+ 10-carried\.conf: NODE_ENV API_PORT PUBLIC_BASE_URL ADMINFORGE_ENV_OVERLAY NODE_EXTRA_CA_CERTS/,
      );
      expect(out).toContain('adminforge-runner.service (User=adminforge-runner)');
      expect(out).toContain('not carried from the user unit: SOMETHING_ELSE');
      // The loopback firewall allows Postgres, the runner (its own port), the API and the proxy.
      expect(out).toContain('meta skuid "adminforge" tcp dport { 55432, 3102, 3300, 8443 } accept');
      expect(out).toContain('counter reject');
      expect(out).toContain('Dry run: nothing was changed.');
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(URL_VALUE);
      expect(s.written()).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  it('refuses an uncommitted or stale checkout', () => {
    const dirty = sandbox({ dirty: true });
    const stale = sandbox({ stale: true });
    try {
      const d = dirty.run();
      expect(d.status).toBe(1);
      expect(d.stdout).toContain('✗ the checkout has uncommitted changes');
      expect(d.stdout).toContain('Nothing was changed.');
      const st = stale.run();
      expect(st.status).toBe(1);
      expect(st.stdout).toContain(
        '✗ stale build: portal/apps/api/dist/main.js is older than the last change to its sources',
      );
    } finally {
      dirty.cleanup();
      stale.cleanup();
    }
  });

  it('never copies an admin or owner file, even when the overlay is named that way', () => {
    for (const overlay of ['admin', 'owner']) {
      const s = sandbox({ overlay });
      try {
        const r = s.run();
        expect(r.status).toBe(1);
        expect(r.stdout).toContain(`✗ refusing to copy dev.${overlay}.env`);
        expect(s.written()).toBe(0);
      } finally {
        s.cleanup();
      }
    }
  });

  it('refuses symlinks: a config file, the CA certificate, the state directory', () => {
    const s = sandbox();
    try {
      const cfg = path.join(s.home, '.config/adminforge');
      rmSync(path.join(cfg, 'dev.host.env'));
      symlinkSync('/etc/hostname', path.join(cfg, 'dev.host.env'));
      rmSync(path.join(s.home, '.local/share/caddy/root.crt'));
      symlinkSync('/etc/hostname', path.join(s.home, '.local/share/caddy/root.crt'));
      mkdirSync(s.at('var/lib'), { recursive: true });
      symlinkSync('/etc', s.at('var/lib/adminforge'));
      const artifacts = path.join(s.home, '.local/share/adminforge/artifacts');
      rmSync(artifacts, { recursive: true });
      symlinkSync('/etc', artifacts);
      const r = s.run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('✗ dev.host.env is a symlink');
      expect(r.stdout).toContain('✗ NODE_EXTRA_CA_CERTS must name a regular file');
      expect(r.stdout).toContain('is a symlink — refusing to write through it');
      expect(r.stdout).toContain("/artifacts must be a directory in avery's home (not a symlink)");
    } finally {
      s.cleanup();
    }
  });

  it('refuses a path into a home directory, and settings that aren’t one plain token', () => {
    const s = sandbox({
      extraBase: 'CONTENT_DIR=~/content',
      extraOverride: 'Environment=NODE_ENV=prod%n\nEnvironment=CONTENT_SOURCE="db"',
    });
    try {
      const r = s.run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(
        "✗ CONTENT_DIR in dev.env points into a home directory the services can't read",
      );
      expect(r.stdout).toMatch(/not carried from the user unit: .*NODE_ENV.*CONTENT_SOURCE/);
    } finally {
      s.cleanup();
    }
  });

  it('refuses an overlay without the services’ own DATABASE_URL, or with an owner role', () => {
    for (const [overlay, message] of [
      ['AF_TENANT_ID=x\n', "dev.host.env doesn't set DATABASE_URL"],
      [
        `DATABASE_URL=postgres://adminforge:${SECRET}@127.0.0.1:55432/adminforge\n`,
        'connects as an owner role',
      ],
    ] as const) {
      const s = sandbox();
      try {
        writeFileSync(path.join(s.home, '.config/adminforge/dev.host.env'), overlay);
        const r = s.run();
        expect(r.status).toBe(1);
        expect(r.stdout).toContain(message);
        expect(r.stdout).not.toContain(SECRET);
      } finally {
        s.cleanup();
      }
    }
  });

  it('refuses an existing account in a privileged group or with a login shell', () => {
    const s = sandbox({ account: { groups: 'adminforge docker' } });
    try {
      const r = s.run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('✗ user adminforge exists and is in the docker group');
    } finally {
      s.cleanup();
    }
  });

  it('changing modes refuse without root; the test hooks refuse root', () => {
    const s = sandbox();
    try {
      // Without AF_SA_PREFIX the changing modes need root.
      const r = spawnSync('bash', [SCRIPT, '--apply'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
      if (process.getuid?.() !== 0) {
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('run it with sudo');
      }
      const asRoot = sandbox({ uid: 0 });
      try {
        const rr = asRoot.run('--dry-run');
        expect(rr.status).toBe(1);
        expect(rr.stderr).toContain('for the test suite only; refusing them as root');
      } finally {
        asRoot.cleanup();
      }
    } finally {
      s.cleanup();
    }
  });
});

describe('install-service-account.sh --apply, --release, --rollback (test root)', () => {
  it('installs, releases, keeps the newest three, never touches the live tree, and rolls back', () => {
    const s = sandbox({
      extraBase: [
        'AF_AUTOMATION_CERT_PATH=~/.config/adminforge/automation.pem',
        `AF_IDENTITY_REPORTS_TEAM_CLIENT_SECRET=${SECRET}`,
        'AF_IDENTITY_REPORTS_TEAM_CERT_PATH=~/.config/adminforge/automation.pem',
        'AF_IDENTITY_REPORTS_TEAM_ALLOW_WRITE_PERMISSIONS=true',
      ].join('\n'),
    });
    try {
      const a = s.run('--apply', '--firewall');
      expect(a.stdout + a.stderr).not.toContain(SECRET);
      expect(a.status).toBe(0);
      expect(a.stdout).toContain('Switch over');
      // Configuration: allow-listed keys only, the certificate copied and the path rewritten.
      const base = readFileSync(s.at('etc/adminforge/dev.env'), 'utf8');
      expect(base).toContain('AF_TENANT_ID=x');
      expect(base).toContain('AF_AUTOMATION_CERT_PATH=/etc/adminforge/automation.pem');
      // Named app identities are documented as a pattern; their opt-ins belong in the admin file.
      expect(base).toContain(`AF_IDENTITY_REPORTS_TEAM_CLIENT_SECRET=${SECRET}`);
      expect(base).toContain('AF_IDENTITY_REPORTS_TEAM_CERT_PATH=/etc/adminforge/identity-reports-team.pem');
      expect(base).not.toContain('ALLOW_WRITE_PERMISSIONS');
      expect(existsSync(s.at('etc/adminforge/identity-reports-team.pem'))).toBe(true);
      expect(base).not.toMatch(/DATABASE_URL|AF_TEST_|UNDOCUMENTED_KEY/);
      expect(readFileSync(s.at('etc/adminforge/dev.runner.env'), 'utf8')).toBe(
        `RUNNER_SHARED_KEY=${SECRET}\nRUNNER_PORT=3102\nLOG_LEVEL=info\n`,
      );
      expect(statSync(s.at('etc/adminforge/dev.runner.env')).mode & 0o777).toBe(0o600);
      expect(existsSync(s.at('etc/adminforge/automation.pem'))).toBe(true);
      expect(existsSync(s.at('etc/adminforge/dev.admin.env'))).toBe(false);
      expect(existsSync(s.at('etc/adminforge/dev.host.owner.env'))).toBe(false);
      // State imported once; units, tmpfiles and the firewall written.
      expect(readdirSync(s.at('var/lib/adminforge/artifacts/reports.x'))).toEqual(['2026-10-17.csv']);
      expect(readFileSync(s.at('etc/systemd/system/adminforge-api.service'), 'utf8')).toContain(
        'User=adminforge',
      );
      expect(
        readFileSync(s.at('etc/systemd/system/adminforge-api.service.d/10-carried.conf'), 'utf8'),
      ).toContain(`Environment=PUBLIC_BASE_URL=${URL_VALUE}`);
      expect(readFileSync(s.at('etc/tmpfiles.d/adminforge.conf'), 'utf8')).toContain(
        'd /var/lib/adminforge-runner 0750 adminforge-runner adminforge-runner -',
      );
      expect(existsSync(s.at('etc/adminforge/loopback.nft'))).toBe(true);
      // The release holds the build, never env files or keys.
      const first = s.current();
      expect(first).toMatch(/^releases\/[0-9a-f]{12}\.\d{10}$/);
      expect(existsSync(s.at(`opt/adminforge/${first}/portal/apps/api/dist/main.js`))).toBe(true);
      expect(existsSync(s.at(`opt/adminforge/${first}/.git`))).toBe(false);

      // A second --apply leaves the state alone (nothing re-imported over what the services wrote).
      writeFileSync(s.at('var/lib/adminforge/artifacts/written-by-service.csv'), 'x');
      expect(s.run('--apply').status).toBe(0);
      expect(existsSync(s.at('var/lib/adminforge/artifacts/written-by-service.csv'))).toBe(true);

      // Re-releasing the same commit makes a new directory; the live one stays until it is old enough to prune.
      const second = s.current();
      const r1 = s.run('--release');
      expect(r1.status).toBe(0);
      expect(r1.stdout).toContain('--rollback');
      const third = s.current();
      expect(third).not.toBe(second);
      expect(existsSync(s.at(`opt/adminforge/${second}`))).toBe(true);
      // Unchanged files are hard links to the previous release (owner and mode set as they are copied).
      const ino = (rel: string) => statSync(s.at(`opt/adminforge/${rel}/package.json`)).ino;
      expect(ino(third)).toBe(ino(second));
      s.commit('two');
      expect(s.run('--release').status).toBe(0);
      const fourth = s.current();
      // Four releases made (apply, apply, release, release): only the newest three stay, current included.
      expect(s.releases()).toHaveLength(3);
      expect(s.releases()).toContain(path.basename(fourth));
      expect(existsSync(s.at(`opt/adminforge/${first}`))).toBe(false);

      const back = s.run('--rollback');
      expect(back.status).toBe(0);
      expect(s.current()).toBe(third);
      expect(lstatSync(s.at('opt/adminforge/current')).isSymbolicLink()).toBe(true);
    } finally {
      s.cleanup();
    }
  }, 60_000);

  it('--sync-config copies the configuration again without a release', () => {
    const ROTATED =
      'DATABASE_URL=postgres://adminforge_app:rotated@127.0.0.1:55432/adminforge\nAF_TENANT_ID=rotated\n';
    const s = sandbox();
    try {
      expect(s.run('--apply').status).toBe(0);
      const releases = s.releases();
      writeFileSync(path.join(s.home, '.config/adminforge/dev.host.env'), ROTATED);
      const r = s.run('--sync-config');
      expect(r.status).toBe(0);
      expect(readFileSync(s.at('etc/adminforge/dev.host.env'), 'utf8')).toBe(ROTATED);
      expect(s.releases()).toEqual(releases);
      expect(r.stdout).toContain('try-restart');
    } finally {
      s.cleanup();
    }
  }, 30_000);
});

describe('the system units', () => {
  const units = (() => {
    const r = spawnSync('bash', [SCRIPT, '--print-units', '--env', 'dev'], { encoding: 'utf8' });
    const out: Record<string, string> = {};
    for (const part of r.stdout.split(/^### /m).filter(Boolean)) {
      const [name, ...body] = part.split('\n');
      out[name!.trim()] = body.join('\n');
    }
    return out;
  })();

  it.each(['api', 'worker', 'scheduler', 'runner'])('adminforge-%s is sandboxed', (u) => {
    const unit = units[`adminforge-${u}.service`]!;
    expect(unit).toBeDefined();
    for (const line of [
      'NoNewPrivileges=yes',
      'ProtectSystem=strict',
      'ProtectHome=yes',
      'PrivateTmp=yes',
      'PrivateDevices=yes',
      'ProtectKernelTunables=yes',
      'ProtectKernelModules=yes',
      'ProtectKernelLogs=yes',
      'ProtectControlGroups=yes',
      'RestrictSUIDSGID=yes',
      'CapabilityBoundingSet=',
      'AmbientCapabilities=',
      'SystemCallFilter=@system-service',
      'InaccessiblePaths=-/run/docker.sock',
      'SocketBindDeny=any',
      'UMask=0027',
    ])
      expect(unit.split('\n')).toContain(line);
    expect(unit).toMatch(/^WorkingDirectory=\/opt\/adminforge\/current\/portal\/apps\//m);
    expect(unit).toMatch(/^ExecStart=\/opt\/adminforge\/runtime\/node\/bin\/node dist\/(main|worker)\.js$/m);
    expect(unit).not.toContain('MemoryDenyWriteExecute');
    expect(unit).not.toMatch(/%h|\/home\//);
    expect(unit).not.toMatch(/@[A-Z_]+@/);
  });

  it('api, worker and scheduler run as adminforge with its state; only the api may listen', () => {
    for (const u of ['api', 'worker', 'scheduler']) {
      const unit = units[`adminforge-${u}.service`]!.split('\n');
      for (const line of [
        'User=adminforge',
        'StateDirectory=adminforge',
        'StateDirectoryMode=0750',
        'NoExecPaths=/var/lib/adminforge',
        'Environment=ADMINFORGE_ENV_FILE=/etc/adminforge/dev.env',
        'Environment=ADMINFORGE_ARTIFACTS_DIR=/var/lib/adminforge/artifacts',
      ])
        expect(unit).toContain(line);
      expect(unit.some((l) => l.startsWith('EnvironmentFile='))).toBe(false);
    }
    expect(units['adminforge-api.service']!.split('\n')).toContain('SocketBindAllow=tcp:3300');
    expect(units['adminforge-worker.service']).not.toContain('SocketBindAllow');
  });

  it('the runner is its own account: its env file only, no view of the API’s configuration or state', () => {
    const runner = units['adminforge-runner.service']!.split('\n');
    for (const line of [
      'User=adminforge-runner',
      'Group=adminforge-runner',
      'EnvironmentFile=/etc/adminforge/dev.runner.env',
      'Environment=HOME=/var/lib/adminforge-runner',
      'StateDirectory=adminforge-runner',
      'InaccessiblePaths=/etc/adminforge /var/lib/adminforge',
      'NoExecPaths=/var/lib/adminforge-runner',
      'SocketBindAllow=tcp:3101',
      'Environment=PWSH_PATH=/opt/adminforge/runtime/powershell/pwsh',
    ])
      expect(runner).toContain(line);
    expect(runner.join('\n')).not.toContain('ADMINFORGE_ENV_FILE');
  });
});
