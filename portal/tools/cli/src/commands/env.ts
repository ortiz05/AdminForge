/**
 * `adminforge env check [--for <purposes>]` — checks the local configuration against config/example.env.
 *
 * Reads the same layered files the CLI uses (the env file, <env>.admin.env, and the ADMINFORGE_ENV_OVERLAY file if
 * set; `@adminforge/config` `envFiles`) overlaid by the process environment, then prints each key's name and state
 * (set, default, missing, invalid) and readiness per purpose (env/env-check.ts). Never prints a value. Also warns when
 * admin-only keys (provisioner and live-test credentials) sit in the runtime env file, which the services read.
 *
 * Read-only: changes nothing locally or in the tenant. Exit code 1 when a purpose selected with --for (default all)
 * is not ready.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ADMIN_ENV_KEYS,
  envFiles,
  envFilePath,
  overlayEnvFilePath,
  parseEnv,
  repoRoot,
} from '@adminforge/config';
import { checkEnv, formatEnvReport, PURPOSES, RETIRED_KEYS, type Purpose } from '../env/env-check';
import { ConfigError } from '../shared/errors';
import type { Out } from '../shared/output';

/** `--for` value → purposes: `all` (or nothing) is every purpose; unknown names are a ConfigError. */
export function parsePurposes(raw: string | undefined): Purpose[] {
  if (!raw || raw === 'all') return [...PURPOSES];
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = list.filter((p) => !(PURPOSES as readonly string[]).includes(p));
  if (bad.length)
    throw new ConfigError(`Unknown purpose(s): ${bad.join(', ')}. Use ${PURPOSES.join(', ')} or all.`);
  return list as Purpose[];
}

/** `adminforge env check [--for <purposes>]` — key names and states only, never values. Returns true when ready. */
export function envCheck(out: Out, opts: { for?: string; env?: NodeJS.ProcessEnv } = {}): boolean {
  const procEnv = opts.env ?? process.env;
  const file = envFilePath(procEnv);
  const exampleText = readFileSync(path.join(repoRoot, 'config', 'example.env'), 'utf8');
  if (!existsSync(file)) out(`Env file not found: ${file} (copy config/example.env there and fill it in)`);
  // The layers the CLI reads: the env file, <env>.admin.env and the overlay if ADMINFORGE_ENV_OVERLAY is set (key
  // states only — values are never printed).
  const fileValues: Record<string, string> = {};
  for (const f of envFiles(procEnv, { admin: true }))
    if (existsSync(f)) Object.assign(fileValues, parseEnv(readFileSync(f, 'utf8')));
  const report = checkEnv(exampleText, fileValues, procEnv);
  const { lines, ok } = formatEnvReport(report, file, parsePurposes(opts.for));
  for (const l of lines) out(l);
  // Admin credentials in the runtime file are readable by every service: point at the admin file instead.
  const runtime = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const misplaced = ADMIN_ENV_KEYS.filter((k) => runtime[k]);
  if (misplaced.length)
    out(
      `Move ${misplaced.join(', ')} from ${path.basename(file)} to ${path.basename(file).replace(/\.env$/, '')}.admin.env (mode 600): the services read ${path.basename(file)}, and only the CLI and live tests need these.`,
    );
  // Keys of the Postgres era (ADR-016): nothing reads them any more.
  const overlay = overlayEnvFilePath(procEnv);
  for (const f of [file, ...(overlay ? [overlay] : [])]) {
    const values = existsSync(f) ? parseEnv(readFileSync(f, 'utf8')) : {};
    const old = RETIRED_KEYS.filter((k) => values[k]);
    if (old.length)
      out(
        `${path.basename(f)} still sets ${old.join(', ')}: AdminForge no longer uses ${old.length > 1 ? 'them' : 'it'} (the database is the SQLite file in DATABASE_PATH, and the API runs the worker and the scheduler). Remove ${old.length > 1 ? 'them' : 'it'}.`,
      );
  }
  return ok;
}
