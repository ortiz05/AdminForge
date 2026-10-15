import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type RunnerConfig, modulesLockPath } from './config';
import type { PoolStatus, WorkerPool } from './pool';

export interface ModulesLock {
  repository?: string;
  modules: Record<string, string>;
  devModules?: Record<string, string>;
}

export function readModulesLock(file = modulesLockPath()): ModulesLock {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ModulesLock>;
    return { ...parsed, modules: parsed.modules ?? {} };
  } catch {
    return { modules: {} };
  }
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'unavailable';
  pool: PoolStatus;
  pwsh: { path: string; version: string | null };
  modules: {
    dir: string;
    items: Array<{ name: string; pinned: string; installed: boolean; loaded: string | null }>;
    preloadFailures: Array<{ name: string; error: string }>;
  };
  scripts: { dir: string; exists: boolean };
  jobs: { running: number };
}

export function healthReport(
  config: RunnerConfig,
  pool: WorkerPool,
  lock: ModulesLock,
  runningJobs: number,
): HealthReport {
  const ready = pool.lastReady;
  const loaded = new Map((ready?.modules ?? []).map((m) => [m.name.toLowerCase(), m.version]));
  const items = Object.entries(lock.modules).map(([name, pinned]) => ({
    name,
    pinned,
    installed: existsSync(path.join(config.modulesDir, name, pinned, `${name}.psd1`)),
    loaded: loaded.get(name.toLowerCase()) ?? null,
  }));
  const preloadFailures = ready?.failed ?? [];
  const poolStatus = pool.status();
  const scriptsExist = existsSync(config.scriptsDir);
  let status: HealthReport['status'] = 'ok';
  if (pool.isUnavailable()) status = 'unavailable';
  else if (
    items.some((m) => !m.installed) ||
    preloadFailures.length ||
    poolStatus.consecutiveFailures > 0 ||
    !scriptsExist
  )
    status = 'degraded';
  return {
    status,
    pool: poolStatus,
    pwsh: { path: config.pwshPath, version: ready?.pwsh ?? null },
    modules: { dir: config.modulesDir, items, preloadFailures },
    scripts: { dir: config.scriptsDir, exists: scriptsExist },
    jobs: { running: runningJobs },
  };
}
