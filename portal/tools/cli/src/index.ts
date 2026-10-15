#!/usr/bin/env -S npx tsx
import { ApiError } from '@adminforge/connectors';
import { envFilePath, loadEnv, updateEnvFile } from '@adminforge/config';
import { Command } from 'commander';
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

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof ConfigError || err instanceof TokenError) console.error(`✗ ${err.message}`);
  else if (err instanceof ApiError) console.error(`✗ ${err.status} ${err.code}: ${err.message}${err.requestId ? ` (request-id ${err.requestId})` : ''}`);
  else console.error(err);
  process.exitCode = 1;
}
