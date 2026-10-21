import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// <env>.admin.env holds the provisioner's credentials (and the test accounts'). Only the commands that act as the
// provisioner read it — `provision …` and `validate --scopes` — never the content commands, `audit` or `db` (S-18).
// This drives the real command line (portal/tools/cli/src/index.ts) with the command modules replaced by recorders
// of the configuration each one is handed.
const received = vi.hoisted(() => [] as Array<{ command: string; env: Record<string, string | undefined> }>);
const record = (command: string) => (first: { env?: Record<string, string | undefined> }) => {
  received.push({ command, env: first.env ?? {} });
};
const recordEnv = (command: string) => (env: Record<string, string | undefined>) => {
  received.push({ command, env });
};

vi.mock('@adminforge/cli/src/commands/validate', () => ({
  validateContent: async (ctx: never) => (record('validate')(ctx), true),
}));
vi.mock('@adminforge/cli/src/commands/test', () => ({
  testContent: async (ctx: never) => (record('test')(ctx), true),
}));
vi.mock('@adminforge/cli/src/commands/publish', () => ({
  publishContent: async (ctx: never) => (record('publish')(ctx), { refused: false }),
}));
vi.mock('@adminforge/cli/src/commands/new', () => ({
  newDefinition: async (ctx: never) => record('new')(ctx),
}));
vi.mock('@adminforge/cli/src/commands/fixtures', () => ({
  recordFixtures: async (ctx: never) => (record('fixtures record')(ctx), true),
}));
vi.mock('@adminforge/cli/src/commands/audit', () => ({
  auditVerify: async (env: never) => (recordEnv('audit verify')(env), true),
}));
vi.mock('@adminforge/cli/src/commands/db', () => ({
  dbBackup: async (env: never) => recordEnv('db backup')(env),
  dbSignOutEveryone: async (env: never) => recordEnv('db sign-out-everyone')(env),
  importPostgres: async (env: never) => recordEnv('db import-postgres')(env),
}));
vi.mock('@adminforge/cli/src/commands/provision', () => ({
  provisionEntra: async (ctx: never) => record('provision entra')(ctx),
  provisionTestIdentities: async (ctx: never) => record('provision test-identities')(ctx),
  setTesterEnabled: async (ctx: never) => record('provision test-identities --enable')(ctx),
  provisionStatus: async (ctx: never) => (record('provision status')(ctx), { ok: true }),
}));
vi.mock('@adminforge/cli/src/commands/test-fixtures', () => ({
  removeTestFixtures: async (ctx: never) => record('provision test-identities --remove-fixtures')(ctx),
}));
vi.mock('@adminforge/cli/src/commands/azure-test', () => ({
  provisionAzureTest: async (ctx: never) => (record('provision azure-test')(ctx), { verify: { ok: true } }),
  destroyAzureTestRun: async (ctx: never) => record('provision azure-test --destroy')(ctx),
}));
vi.mock('@adminforge/cli/src/commands/env', () => ({ envCheck: () => true }));

const ADMIN_SECRET = 'synthetic-provisioner-secret';
let dir: string;
const saved = { file: process.env.ADMINFORGE_ENV_FILE, overlay: process.env.ADMINFORGE_ENV_OVERLAY };

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'af-admin-scope-'));
  writeFileSync(path.join(dir, 'dev.env'), 'RUNTIME_FILE_MARK=1\nDATABASE_PATH=/nonexistent/x.db\n', {
    mode: 0o600,
  });
  writeFileSync(
    path.join(dir, 'dev.admin.env'),
    `ADMIN_FILE_MARK=1\nAF_PROVISIONER_CLIENT_ID=00000000-0000-4000-8000-000000000001\nAF_PROVISIONER_CLIENT_SECRET=${ADMIN_SECRET}\n`,
    { mode: 0o600 },
  );
  process.env.ADMINFORGE_ENV_FILE = path.join(dir, 'dev.env');
  delete process.env.ADMINFORGE_ENV_OVERLAY;
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved.file === undefined) delete process.env.ADMINFORGE_ENV_FILE;
  else process.env.ADMINFORGE_ENV_FILE = saved.file;
  if (saved.overlay !== undefined) process.env.ADMINFORGE_ENV_OVERLAY = saved.overlay;
});

/** Runs `adminforge <args>` in this process and returns what the command module was handed. */
async function run(...args: string[]) {
  received.length = 0;
  const argv = process.argv;
  process.argv = [process.execPath, 'adminforge', ...args];
  vi.resetModules();
  try {
    await import('@adminforge/cli/src/index');
  } finally {
    process.argv = argv;
    const failed = process.exitCode;
    process.exitCode = undefined;
    expect(failed ?? 0, `adminforge ${args.join(' ')} failed`).toBe(0);
  }
  expect(received, `adminforge ${args.join(' ')}`).toHaveLength(1);
  return received[0]!;
}

describe('which commands read <env>.admin.env', () => {
  it.each([
    'validate',
    'test',
    'test identity.',
    'publish --dry-run',
    'new page identity/stale-guests',
    'fixtures record identity.users',
    'audit verify',
    'db backup -',
    'db sign-out-everyone',
    'db import-postgres --dry-run',
  ])(
    'adminforge %s reads the runtime configuration only',
    async (command) => {
      const { env } = await run(...command.split(' '));
      expect(env.RUNTIME_FILE_MARK).toBe('1');
      expect(env.ADMIN_FILE_MARK, 'the admin file was read').toBeUndefined();
      expect(env.AF_PROVISIONER_CLIENT_ID).toBeUndefined();
      expect(Object.values(env)).not.toContain(ADMIN_SECRET);
    },
    30_000,
  );

  it.each([
    'validate --scopes',
    'provision status',
    'provision entra --dry-run',
    'provision test-identities --dry-run',
    'provision test-identities --enable',
    'provision test-identities --remove-fixtures --dry-run',
    'provision azure-test --dry-run',
  ])(
    'adminforge %s acts as the provisioner and reads it',
    async (command) => {
      const { env } = await run(...command.split(' '));
      expect(env.RUNTIME_FILE_MARK).toBe('1');
      expect(env.ADMIN_FILE_MARK).toBe('1');
      expect(env.AF_PROVISIONER_CLIENT_SECRET).toBe(ADMIN_SECRET);
    },
    30_000,
  );
});
