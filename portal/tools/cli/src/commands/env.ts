import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ADMIN_ENV_KEYS, envFiles, envFilePath, parseEnv, repoRoot } from '@adminforge/config';
import { checkEnv, formatEnvReport, PURPOSES, type Purpose } from '../env-check';
import { ConfigError } from './context';
import type { Out } from '../provision/render';

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
  // The same layers the CLI reads: the env file, <env>.admin.env, and the overlay if ADMINFORGE_ENV_OVERLAY is set.
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
  return ok;
}
