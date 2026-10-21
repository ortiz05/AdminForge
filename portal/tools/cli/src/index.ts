#!/usr/bin/env -S npx tsx
/**
 * The `adminforge` command line (`pnpm adminforge …`): wires each command to its module and turns failures into one
 * readable line. Command reference, env keys and exit codes: portal/tools/cli/README.md.
 *
 * Layers (each imports only from the ones below it):
 *   index.ts → commands/* (one module per command) → content/*, env/*, provision/* → shared/*.
 * Every command takes its outside world as a context object (`CliContext`, `ContentCliContext`) built here from the
 * env file (outside the repo, R2: @adminforge/config `loadEnv`, including <env>.admin.env) and `console.log`, so tests
 * can run the same functions with fakes.
 *
 * Exit codes: 0 success; 1 when a command reports a problem (validation errors, failed tests, drift, a refused
 * publish) or throws. Thrown errors print as `✗ <message>`: ConfigError, TokenError and EnvFileModeError (an env file
 * other users may read) as they are, ApiError with its status, code and request id, anything else through
 * `describeFailure`; the stack only with ADMINFORGE_DEBUG=1.
 */
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import { EnvFileModeError, loadEnv, repoRoot, writeEnvKeys } from '@adminforge/config';
import { ApiError } from '@adminforge/connectors';
import { auditVerify } from './commands/audit';
import { destroyAzureTestRun, provisionAzureTest } from './commands/azure-test';
import { dbBackup, dbSignOutEveryone, importPostgres } from './commands/db';
import { envCheck } from './commands/env';
import { recordFixtures } from './commands/fixtures';
import { newDefinition } from './commands/new';
import {
  provisionEntra,
  provisionStatus,
  provisionTestIdentities,
  setTesterEnabled,
} from './commands/provision';
import { removeTestFixtures } from './commands/test-fixtures';
import { publishContent } from './commands/publish';
import { testContent } from './commands/test';
import { validateContent } from './commands/validate';
import { contentContext } from './content/context';
import { TokenError } from './provision/auth';
import type { CliContext } from './provision/clients';
import { ConfigError, describeFailure } from './shared/errors';

/** Real-world context: env file outside the repo (R2), stdout, global fetch. */
function liveContext(): CliContext {
  // The CLI is admin tooling: it also reads <env>.admin.env (provisioner and live-test credentials).
  const env = loadEnv(process.env, { admin: true });
  return {
    env,
    writeEnv: (updates) => {
      writeEnvKeys(updates);
      Object.assign(env, updates);
    },
    out: (line) => console.log(line),
  };
}

/** One line from the terminal (confirmation prompts). */
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const program = new Command()
  .name('adminforge')
  .description(
    'AdminForge CLI. Configuration comes from ~/.config/adminforge/<env>.env (override with ADMINFORGE_ENV_FILE).',
  )
  .showHelpAfterError();

const env = program.command('env').description('Configuration checks');
env
  .command('check')
  .description('Validate the env file against config/example.env (prints key names and states, never values)')
  .option(
    '--for <purposes>',
    'which readiness checks decide the exit code: provision, portal, schedules, validation (comma-separated) or all',
    'all',
  )
  .action((opts: { for: string }) => {
    if (!envCheck((l) => console.log(l), { for: opts.for })) process.exitCode = 1;
  });

const provision = program
  .command('provision')
  .description('Idempotent provisioning of Entra / Azure objects for this environment');
provision
  .command('entra')
  .description(
    'Create or update the AdminForge Read/Write/Automation apps, groups, consent, and automation RBAC',
  )
  .option('--dry-run', 'print the plan without changing anything')
  .option(
    '--prune',
    "also remove application permissions on AdminForge's apps that provisioning doesn't grant (retired content, dropped baseline permissions, ones a ceiling withholds, ones added by hand); permissions on resources provisioning doesn't know are left alone",
  )
  .action(async (opts: { dryRun?: boolean; prune?: boolean }) => {
    await provisionEntra(liveContext(), { dryRun: opts.dryRun, prune: opts.prune });
  });
provision
  .command('test-identities')
  .description(
    'Create the validation user (disabled), AF-Test-* write-test targets and the opted-in licensed test fixtures (AF_TEST_LICENCE_SKU, AF_TEST_FIXTURES) — test environments only (AF_TEST_IDENTITY_LABELS)',
  )
  .option('--dry-run', 'print the plan without changing anything')
  .option('--enable', 'only enable the validation user’s sign-in (before a live run)')
  .option(
    '--disable',
    'disable the validation user and the approver fixture, revoking their sessions (after a live run)',
  )
  .option(
    '--approver',
    'with --enable: also enable the approver fixture (AF Tester 2), only for approval tests',
  )
  .option(
    '--remove-fixtures',
    'remove what the opted-in test fixtures created (AF_TEST_LICENCE_SKU, AF_TEST_FIXTURES); with --dry-run, only the plan',
  )
  .action(
    async (opts: {
      dryRun?: boolean;
      enable?: boolean;
      disable?: boolean;
      approver?: boolean;
      removeFixtures?: boolean;
    }) => {
      if (opts.enable && opts.disable) throw new ConfigError('Use either --enable or --disable, not both.');
      if (opts.approver && !opts.enable)
        throw new ConfigError('--approver goes with --enable only: --disable always disables both accounts.');
      if (opts.removeFixtures) {
        if (opts.enable || opts.disable)
          throw new ConfigError('--remove-fixtures does not combine with --enable/--disable.');
        await removeTestFixtures(liveContext(), { dryRun: opts.dryRun });
        return;
      }
      if (opts.enable || opts.disable) {
        if (opts.dryRun)
          throw new ConfigError('--dry-run plans provisioning; it does not combine with --enable/--disable.');
        await setTesterEnabled(liveContext(), !!opts.enable, { approver: opts.approver });
        return;
      }
      await provisionTestIdentities(liveContext(), { dryRun: opts.dryRun });
    },
  );
provision
  .command('azure-test')
  .description(
    'Create the Azure test environment for live KQL validation: resource group AF-Test-<label>, a Log Analytics workspace (daily cap 0.1 GB), the subscription activity log export, and read access for the automation identity and the validation user',
  )
  .option('--dry-run', 'print the plan without changing anything')
  .option('--no-verify', 'skip the Log Analytics query check as the automation identity')
  .option('--destroy', 'delete the resource group, the workspace and the diagnostic setting')
  .option('--yes', 'with --destroy: do not ask for confirmation')
  .action(async (opts: { dryRun?: boolean; verify?: boolean; destroy?: boolean; yes?: boolean }) => {
    if (opts.destroy) {
      await destroyAzureTestRun(liveContext(), {
        yes: opts.yes,
        confirm: process.stdin.isTTY ? ask : undefined,
      });
      return;
    }
    const run = await provisionAzureTest(liveContext(), { dryRun: opts.dryRun, verify: opts.verify });
    if (run.verify && !run.verify.ok) process.exitCode = 1;
  });
provision
  .command('status')
  .description('Show every provisioned object with ✓/✗, plus live token checks')
  .action(async () => {
    const result = await provisionStatus(liveContext());
    if (!result.ok) process.exitCode = 1;
  });

// ── Content: validate · test · publish · new · fixtures (§7.9–7.10) ──────────────
/** `--env <name>` picks ~/.config/adminforge/<name>.env (unless ADMINFORGE_ENV_FILE is set). */
const useEnv = (name?: string) => {
  if (name && !process.env.ADMINFORGE_ENV_FILE) process.env.ADMINFORGE_ENV = name;
};
const content = () =>
  contentContext(loadEnv(process.env, { admin: true }), (line) => console.log(line), repoRoot);

program
  .command('validate')
  .description(
    'Validate portal/content: schema, references, expressions, injection lint ($filter/$search/$orderby, KQL, paths), runner script sha256 pins, env keys; --scopes also compares declared scopes with the app registrations',
  )
  .option(
    '--scopes',
    'compare requires.scopes with the permissions granted to the Read/Write apps and the automation identity (uses the provisioner identity)',
  )
  .option('--env <name>', 'env file to use (~/.config/adminforge/<name>.env)')
  .action(async (opts: { scopes?: boolean; env?: string }) => {
    useEnv(opts.env);
    if (!(await validateContent(content(), { scopes: opts.scopes }))) process.exitCode = 1;
  });

program
  .command('test')
  .argument('[pattern]', 'only definitions whose id or file contains this text')
  .description('Run the tests: blocks of playbooks and runbooks (dry run with mocked step outputs)')
  .action(async (pattern?: string) => {
    if (!(await testContent(content(), { pattern }))) process.exitCode = 1;
  });

const audit = program.command('audit').description('The tamper-evident audit log');
audit
  .command('verify')
  .description('Re-walk the audit hash chain in the database at DATABASE_PATH (read-only)')
  .option('--env <name>', 'env file to use (~/.config/adminforge/<name>.env)', 'dev')
  .action(async (opts: { env?: string }) => {
    useEnv(opts.env);
    if (!(await auditVerify(loadEnv(process.env, { admin: true }), (l) => console.log(l))))
      process.exitCode = 1;
  });

const db = program.command('db').description('The database file (DATABASE_PATH)');
db.command('backup')
  .argument('<file>', 'where to write the copy (a new file), or - for stdout')
  .description(
    'A consistent copy of the database without sessions, sign-ins and tokens, checked (integrity, audit chain), mode 600. Not encrypted: encrypt it before it leaves the machine (with -, pipe it into gpg)',
  )
  .option('--plaintext', 'write the unencrypted copy to <file> (with - it goes to stdout, for gpg)')
  .option('--env <name>', 'env file to use (~/.config/adminforge/<name>.env)')
  .action(async (file: string, opts: { env?: string; plaintext?: boolean }) => {
    useEnv(opts.env);
    await dbBackup(
      loadEnv(process.env),
      file,
      { out: (l) => console.log(l), err: (l) => console.error(l) },
      { plaintext: opts.plaintext },
    );
  });
db.command('sign-out-everyone')
  .description(
    'Emergency: end every session at once (sessions, pending sign-ins and their tokens are deleted; audited). Takes effect while the portal runs. --schedule-grants also voids the stored access of schedules that run as their creator',
  )
  .option('--yes', 'really do it')
  .option('--schedule-grants', "also delete schedules' grant tokens (their creators must consent again)")
  .option('--env <name>', 'env file to use (~/.config/adminforge/<name>.env)')
  .action(async (opts: { yes?: boolean; scheduleGrants?: boolean; env?: string }) => {
    useEnv(opts.env);
    await dbSignOutEveryone(loadEnv(process.env), (l) => console.log(l), opts);
  });
db.command('import-postgres')
  .description(
    'One-time move from a Postgres release: copy its database (URL from DATABASE_URL in the env file) into a new SQLite file and verify the audit chain. Sessions are not copied (everyone signs in again)',
  )
  .option('--to <file>', 'the new database file (default DATABASE_PATH)')
  .option('--from-env <key>', 'the variable that holds the Postgres URL', 'DATABASE_URL')
  .option('--dry-run', 'check the source and show what would be copied, without writing')
  .option('--env <name>', 'env file to use (~/.config/adminforge/<name>.env)')
  .action(async (opts: { to?: string; fromEnv?: string; dryRun?: boolean; env?: string }) => {
    useEnv(opts.env);
    await importPostgres(loadEnv(process.env), (l) => console.log(l), {
      to: opts.to,
      fromEnv: opts.fromEnv,
      dryRun: opts.dryRun,
    });
  });

program
  .command('publish')
  .description(
    'Publish new definition versions from portal/content to the database at DATABASE_PATH (idempotent by sha256) and tell the running portal. Runs the validate and test checks first, and publishes only reviewed content: committed, and the commit merged to origin/main (as last fetched) — in an image, built from such a commit',
  )
  .option('--env <name>', 'env file to use (~/.config/adminforge/<name>.env)', 'dev')
  .option('--dry-run', 'show what would be published (and whether it would be refused) without writing')
  .option(
    '--allow-unreviewed',
    'publish even with uncommitted content changes or a commit that is not on origin/main (recorded in the audit log)',
  )
  .action(async (opts: { env?: string; dryRun?: boolean; allowUnreviewed?: boolean }) => {
    useEnv(opts.env);
    const result = await publishContent(content(), {
      dryRun: opts.dryRun,
      allowUnreviewed: opts.allowUnreviewed,
    });
    if (!result || result.refused) process.exitCode = 1;
  });

program
  .command('new')
  .argument('<kind>', 'page | dashboard | report | playbook | runbook | connection | probe | schedule')
  .argument('<path>', '<section>/<name>, e.g. identity/stale-guests')
  .description(
    'Scaffold a valid definition (with $schema for editor autocomplete) and a fixture stub under tests/fixtures',
  )
  .option('--template <template>', 'pages: list-detail | dashboard | report | entity')
  .option('--owner <team>', 'owner: (default <section>-team)')
  .option('--force', 'overwrite an existing file')
  .action(
    async (kind: string, target: string, opts: { template?: string; owner?: string; force?: boolean }) => {
      await newDefinition(content(), kind, target, opts);
    },
  );

const fixtures = program.command('fixtures').description('Synthetic fixtures for DATA_MODE=fixtures');
fixtures
  .command('record')
  .argument('<page>', 'page, dashboard or report key, e.g. identity.users')
  .description(
    'Read a page live as the automation identity (read-only) and write sanitized fixtures (names, UPNs, domains, GUIDs replaced)',
  )
  .option('--datasource <name>', 'only this datasource')
  .option('--param <key=value>', 'page parameter (repeatable)', (v: string, all: string[] = []) => [
    ...all,
    v,
  ])
  .option('--env <name>', 'env file to use (~/.config/adminforge/<name>.env)')
  .option('--force', 'overwrite existing fixture files')
  .option('--dry-run', 'record and sanitize, but write nothing')
  .action(
    async (
      page: string,
      opts: { datasource?: string; param?: string[]; env?: string; force?: boolean; dryRun?: boolean },
    ) => {
      useEnv(opts.env);
      if (
        !(await recordFixtures(content(), page, {
          datasource: opts.datasource,
          params: opts.param,
          force: opts.force,
          dryRun: opts.dryRun,
        }))
      )
        process.exitCode = 1;
    },
  );

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof ConfigError || err instanceof TokenError || err instanceof EnvFileModeError)
    console.error(`✗ ${err.message}`);
  else if (err instanceof ApiError)
    console.error(
      `✗ ${err.status} ${err.code}: ${err.message}${err.requestId ? ` (request-id ${err.requestId})` : ''}`,
    );
  else console.error(`✗ ${describeFailure(err)}`);
  if (process.env.ADMINFORGE_DEBUG === '1' && err instanceof Error) console.error(err.stack);
  process.exitCode = 1;
}
