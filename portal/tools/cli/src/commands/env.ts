import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { envFilePath, parseEnv, repoRoot } from '@adminforge/config';
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
  const fileValues = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  if (!existsSync(file)) out(`Env file not found: ${file} (copy config/example.env there and fill it in)`);
  const report = checkEnv(exampleText, fileValues, procEnv);
  const { lines, ok } = formatEnvReport(report, file, parsePurposes(opts.for));
  for (const l of lines) out(l);
  return ok;
}
