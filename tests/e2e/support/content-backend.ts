/**
 * Routes content endpoints (definitions, datasources, export, views, search, nav, capabilities) to the real BFF
 * pipeline running in a small local process (backend-server.ts): real content, real transforms, synthetic fixtures.
 * One process per Playwright worker; saved views persist within it like on a real server.
 *
 * `routeContentBackend(page, opts)` wires a page's content requests to it (the specs combine it with mockApi for the
 * session and automation endpoints); `backendUrl()` starts the process on first use.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import { FIXED_NOW } from '../../support/web/fixtures/session';

const here = path.dirname(fileURLToPath(import.meta.url));
let proc: ChildProcess | undefined;
let base: Promise<string> | undefined;

function startBackend(): Promise<string> {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'backend-server.ts')], {
      cwd: path.resolve(here, '../..'),
      env: { ...process.env, NODE_ENV: 'test', E2E_FIXED_NOW: String(FIXED_NOW) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`e2e backend did not start: ${err || out}`)), 60_000);
    proc.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /PORT=(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    proc.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`e2e backend exited (${code}): ${err}`));
    });
  });
}

process.on('exit', () => proc?.kill());

export function backendUrl(): Promise<string> {
  base ??= startBackend();
  return base;
}

export const BACKEND_PATHS =
  /^\/api\/(definitions|datasources|reports|views|search|nav|me\/capabilities)(\/|$|\?)/;

/** Answers one browser request from the backend process. */
export async function forward(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  const res = await fetch(`${await backendUrl()}${url.pathname}${url.search}`, {
    method: route.request().method(),
    headers: route.request().postData() ? { 'content-type': 'application/json' } : {},
    body: route.request().postData() ?? undefined,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (['content-type', 'content-disposition', 'x-correlation-id'].includes(k)) headers[k] = v;
  });
  await route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
}

export interface BackendOptions {
  /** Answer a request in the test instead (return true when handled). */
  override?: (route: Route, url: URL) => Promise<boolean> | boolean;
  /** Every forwarded request, for assertions. */
  calls?: Array<{ method: string; path: string; body: unknown }>;
}

/** Route content endpoints to the backend. Register after mockApi (later routes win). */
export async function routeContentBackend(page: Page, opts: BackendOptions = {}): Promise<void> {
  await page.route(
    (url) => BACKEND_PATHS.test(url.pathname),
    async (route) => {
      const url = new URL(route.request().url());
      const raw = route.request().postData();
      opts.calls?.push({
        method: route.request().method(),
        path: `${url.pathname}${url.search}`,
        body: raw ? JSON.parse(raw) : undefined,
      });
      if (opts.override && (await opts.override(route, url))) return;
      await forward(route);
    },
  );
}
