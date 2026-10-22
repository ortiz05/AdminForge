import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeRunnerKey } from './client';

/** portal/apps/runner (works from src/ under tsx and from dist/ when bundled). */
export const RUNNER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ALL_PRELOAD_SERVICES = ['Graph', 'Exchange', 'Teams', 'SharePoint', 'Az'] as const;
export type PreloadService = (typeof ALL_PRELOAD_SERVICES)[number];

export interface RunnerConfig {
  host: string;
  port: number;
  /** Decoded RUNNER_SHARED_KEY. */
  sharedKey: Buffer;
  /** Warm (pre-forked) workers kept ready. */
  poolSize: number;
  /** Jobs that may run at the same time; further jobs wait for a worker. */
  maxJobs: number;
  scriptsDir: string;
  modulesDir: string;
  workerScript: string;
  pwshPath: string;
  /** Modules each worker imports before it reports ready. */
  preload: PreloadService[];
  /** How long an accepted job may wait for a worker. */
  queueTimeoutMs: number;
  /** Jobs that may wait for a worker at once; one more is refused (503 runner_busy). */
  maxWaiting: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function intFrom(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new ConfigError(`${key} must be an integer between ${min} and ${max}`);
  return n;
}

/** `pwsh` on PATH, else ~/.local/bin/pwsh. */
export function findPwsh(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PWSH_PATH?.trim();
  if (explicit) return explicit;
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'pwsh');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return path.join(homedir(), '.local', 'bin', 'pwsh');
}

export function parsePreload(raw: string | undefined): PreloadService[] {
  if (raw === undefined || raw.trim() === '') return [...ALL_PRELOAD_SERVICES];
  if (raw.trim().toLowerCase() === 'none') return [];
  const out: PreloadService[] = [];
  for (const part of raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const match = ALL_PRELOAD_SERVICES.find((s) => s.toLowerCase() === part.toLowerCase());
    if (!match)
      throw new ConfigError(
        `RUNNER_PRELOAD_MODULES: unknown service "${part}" (use ${ALL_PRELOAD_SERVICES.join(', ')} or none)`,
      );
    if (!out.includes(match)) out.push(match);
  }
  return out;
}

/** Reads runner configuration from the environment (the API / compose file passes it). */
export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const rawKey = env.RUNNER_SHARED_KEY?.trim();
  if (!rawKey)
    throw new ConfigError(
      'RUNNER_SHARED_KEY is required (openssl rand -base64 32); the API uses the same value',
    );
  let sharedKey: Buffer;
  try {
    sharedKey = decodeRunnerKey(rawKey);
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  const poolSize = intFrom(env, 'RUNNER_POOL_SIZE', 2, 1, 16);
  const maxJobs = intFrom(env, 'RUNNER_MAX_JOBS', Math.max(2, poolSize * 2), 1, 64);
  return {
    host: env.RUNNER_HOST?.trim() || '127.0.0.1',
    port: intFrom(env, 'RUNNER_PORT', 3101, 0, 65535),
    sharedKey,
    poolSize,
    maxJobs,
    scriptsDir: path.resolve(
      env.ADMINFORGE_SCRIPTS_DIR?.trim() || path.join(RUNNER_ROOT, '..', '..', 'content', 'scripts'),
    ),
    modulesDir: path.resolve(env.ADMINFORGE_RUNNER_MODULES_DIR?.trim() || path.join(RUNNER_ROOT, 'modules')),
    workerScript: path.join(RUNNER_ROOT, 'ps', 'worker.ps1'),
    pwshPath: findPwsh(env),
    preload: parsePreload(env.RUNNER_PRELOAD_MODULES),
    queueTimeoutMs: intFrom(env, 'RUNNER_QUEUE_TIMEOUT_SECONDS', 60, 1, 3600) * 1000,
    maxWaiting: intFrom(env, 'RUNNER_MAX_WAITING', 4 * maxJobs, 0, 1024),
  };
}

/** Environment variables a worker may inherit. Everything else (notably RUNNER_SHARED_KEY) is withheld. */
const INHERITED_ENV = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

export interface WorkerCommand {
  command: string;
  args: string[];
  /** Complete environment of the worker (HOME/TMPDIR are added per worker by the pool). */
  env: Record<string, string>;
}

/**
 * PowerShell settings for the workers (ps/powershell.config.json, next to worker.ps1), passed with `-SettingsFile`
 * in place of the system-wide powershell.config.json. On Linux PowerShell logs to syslog (the journal), and by default
 * it records every script block it considers suspicious — the pinned modules' source, up to 16 KB per line, at warning
 * priority, hundreds of MB a day — plus parameter values of some commands at informational priority. The file
 * turns script-block, module and transcript logging off explicitly and keeps warnings and errors (LogLevel Warning).
 * The runner's own logs (stdout, protocol events) are unaffected.
 */
export const WORKER_SETTINGS_FILE = 'powershell.config.json';

export function workerSettingsFile(config: Pick<RunnerConfig, 'workerScript'>): string {
  return path.join(path.dirname(config.workerScript), WORKER_SETTINGS_FILE);
}

/**
 * The pwsh command line of a worker. Nothing job-specific ever appears here: the job, including tokens,
 * is written to the worker's stdin after it has started.
 */
export function buildWorkerCommand(
  config: RunnerConfig,
  parentEnv: NodeJS.ProcessEnv = process.env,
): WorkerCommand {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = parentEnv[key];
    if (value) env[key] = value;
  }
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  Object.assign(env, {
    ADMINFORGE_RUNNER_MODULES_DIR: config.modulesDir,
    ADMINFORGE_RUNNER_PRELOAD: config.preload.length ? config.preload.join(',') : 'none',
    POWERSHELL_TELEMETRY_OPTOUT: '1',
    POWERSHELL_UPDATECHECK: 'Off',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
  });
  return {
    command: config.pwshPath,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-SettingsFile',
      workerSettingsFile(config),
      '-File',
      config.workerScript,
    ],
    env,
  };
}

export function modulesLockPath(): string {
  return path.join(RUNNER_ROOT, 'modules.lock.json');
}
