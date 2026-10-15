import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Files git would commit: tracked plus untracked-but-not-ignored. */
export function committableFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
  });
  return out
    .toString('utf8')
    .split('\0')
    .filter((f) => f && existsSync(path.join(repoRoot, f)) && statSync(path.join(repoRoot, f)).isFile());
}

export function readText(rel: string): string | undefined {
  const buf = readFileSync(path.join(repoRoot, rel));
  return buf.includes(0) ? undefined : buf.toString('utf8'); // skip binaries
}

/** Parses KEY=VALUE env files (comments and blanks ignored). */
export function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2] && !line.trimStart().startsWith('#')) out[m[1]!] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Local AdminForge env files (outside the repo). */
export function localEnvFiles(): string[] {
  const explicit = process.env.ADMINFORGE_ENV_FILE;
  if (explicit) return existsSync(explicit) ? [explicit] : [];
  const dir = path.join(homedir(), '.config', 'adminforge');
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.env'))
        .map((f) => path.join(dir, f))
    : [];
}
