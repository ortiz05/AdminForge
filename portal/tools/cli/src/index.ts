#!/usr/bin/env -S npx tsx
import { ApiError } from '@adminforge/connectors';
import { envFilePath, loadEnv, repoRoot, updateEnvFile } from '@adminforge/config';
import { Command } from 'commander';
import { contentContext, newDefinition, publishContent, recordFixtures, testContent, validateContent } from './commands/content';
import { envCheck } from './commands/env';
import { ConfigError, type CliContext } from './commands/context';
import { provisionEntra, provisionStatus, provisionTestIdentities } from './commands/provision';
import { TokenError } from './provision/auth';

/** Real-world context: env file outside the repo (R2), stdout, global fetch. */
function liveContext(): CliContext {
  const env = loadEnv();
  const file = envFilePath();
  return {
    env,
    writeEnv: (updates) => {
      updateEnvFile(updates, file);
      Object.assign(env, updates);
    },
    out: (line) => console.log(line),
  };
}

const program = new Command()
  .name('adminforge')
  .description('AdminForge CLI. Configuration comes from ~/.config/adminforge/<env>.env (override with ADMINFORGE_ENV_FILE).')
  .showHelpAfterError();

const env = program.command('env').description('Configuration checks');
env
  .command('check')
  .description('Validate the env file against config/example.env (prints key names and states, never values)')
  .option('--for <purposes>', 'which readiness checks decide the exit code: provision, portal, schedules, validation (comma-separated) or all', 'all')
  .action((opts: { for: string }) => {
    if (!envCheck((l) => console.log(l), { for: opts.for })) process.exitCode = 1;
  });

const provision = program.command('provision').description('Idempotent provisioning of Entra / Azure objects for this environment');
provision
  .command('entra')
  .description('Create or update the AdminForge Read/Write/Automation apps, groups, consent, and automation RBAC')
  .option('--dry-run', 'print the plan without changing anything')
  .action(async (opts: { dryRun?: boolean }) => {
    await provisionEntra(liveContext(), { dryRun: opts.dryRun });
  });
provision
  .command('test-identities')
  .description('Create the validation user and AF-Test-* write-test targets (test tenants only)')
  .option('--dry-run', 'print the plan without changing anything')
  .action(async (opts: { dryRun?: boolean }) => {
    await provisionTestIdentities(liveContext(), { dryRun: opts.dryRun });
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
const content = () => contentContext(loadEnv(), (line) => console.log(line), repoRoot);

program
  .command('validate')
  .description('Validate portal/content: schema, references, expressions, $filter/$search lint, env keys; --scopes also compares declared scopes with the app registrations')
  .option('--scopes', 'compare requires.scopes with the permissions granted to the Read/Write apps and the automation identity (uses the provisioner identity)')
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

program
  .command('publish')
  .description('Publish new definition versions from portal/content to Postgres (idempotent by sha256) and NOTIFY definitions_changed')
  .option('--env <name>', 'env file to use (~/.config/adminforge/<name>.env)', 'dev')
  .option('--dry-run', 'show what would be published without writing')
  .action(async (opts: { env?: string; dryRun?: boolean }) => {
    useEnv(opts.env);
    const result = await publishContent(content(), { dryRun: opts.dryRun });
    if (!result || result.refused) process.exitCode = 1;
  });

program
  .command('new')
  .argument('<kind>', 'page | dashboard | report | playbook | runbook | connection | probe | schedule')
  .argument('<path>', '<section>/<name>, e.g. identity/stale-guests')
  .description('Scaffold a valid definition (with $schema for editor autocomplete) and a fixture stub under tests/fixtures')
  .option('--template <template>', 'pages: list-detail | dashboard | report | entity')
  .option('--owner <team>', 'owner: (default <section>-team)')
  .option('--force', 'overwrite an existing file')
  .action(async (kind: string, target: string, opts: { template?: string; owner?: string; force?: boolean }) => {
    await newDefinition(content(), kind, target, opts);
  });

const fixtures = program.command('fixtures').description('Synthetic fixtures for DATA_MODE=fixtures');
fixtures
  .command('record')
  .argument('<page>', 'page, dashboard or report key, e.g. identity.users')
  .description('Read a page live as the automation identity (read-only) and write sanitized fixtures (names, UPNs, domains, GUIDs replaced)')
  .option('--datasource <name>', 'only this datasource')
  .option('--param <key=value>', 'page parameter (repeatable)', (v: string, all: string[] = []) => [...all, v])
  .option('--env <name>', 'env file to use (~/.config/adminforge/<name>.env)')
  .option('--force', 'overwrite existing fixture files')
  .option('--dry-run', 'record and sanitize, but write nothing')
  .action(async (page: string, opts: { datasource?: string; param?: string[]; env?: string; force?: boolean; dryRun?: boolean }) => {
    useEnv(opts.env);
    if (!(await recordFixtures(content(), page, { datasource: opts.datasource, params: opts.param, force: opts.force, dryRun: opts.dryRun }))) process.exitCode = 1;
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof ConfigError || err instanceof TokenError) console.error(`✗ ${err.message}`);
  else if (err instanceof ApiError) console.error(`✗ ${err.status} ${err.code}: ${err.message}${err.requestId ? ` (request-id ${err.requestId})` : ''}`);
  else console.error(err);
  process.exitCode = 1;
}
