#!/usr/bin/env node
/**
 * Initial-load budget (plan §6.10): the JavaScript a first visit downloads before anything lazy — the entry module,
 * its modulepreloads and classic scripts in index.html — must stay at or under the gzip budget.
 *
 *   node tooling/ci/check-bundle.mjs [distDir] [budgetKB]    # after `pnpm build`; also `pnpm check:bundle`
 *
 * Defaults: portal/apps/web/dist and 250 KB. Prints the largest files and the total; exits 1 when over the budget or
 * when index.html names no scripts (no build). CI runs it after the production build. The functions are exported for
 * tests/unit/tooling/check-bundle.test.ts.
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const DEFAULT_DIST = 'portal/apps/web/dist';
export const DEFAULT_BUDGET_KB = 250;

/**
 * The scripts a first visit loads: `<script src="….js">` and `<link rel="modulepreload" href="….js">`, in document
 * order, without duplicates.
 * @param {string} html
 * @returns {string[]}
 */
export function initialScripts(html) {
  const files = new Set();
  for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+\.js)"/g)) files.add(m[1]);
  for (const m of html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+\.js)"/g)) files.add(m[1]);
  return [...files];
}

/**
 * Gzip size (level 9) of each initial script of a build, largest first.
 * @param {string} dist  the build output directory (holds index.html)
 * @returns {{ files: Array<{ file: string; gzipBytes: number }>; totalBytes: number }}
 */
export function measureInitialLoad(dist) {
  const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
  const files = initialScripts(html).map((file) => ({
    file,
    gzipBytes: gzipSync(readFileSync(path.join(dist, file.replace(/^\//, ''))), { level: 9 }).length,
  }));
  files.sort((a, b) => b.gzipBytes - a.gzipBytes);
  return { files, totalBytes: files.reduce((sum, f) => sum + f.gzipBytes, 0) };
}

const kb = (n) => (n / 1024).toFixed(1);

/**
 * Checks a build against the budget and returns what to print.
 * @param {string} dist
 * @param {number} budgetKb
 * @returns {{ ok: boolean; out: string[]; err: string[] }}
 */
export function checkBundle(dist, budgetKb) {
  const { files, totalBytes } = measureInitialLoad(dist);
  if (!files.length)
    return {
      ok: false,
      out: [],
      err: [`✗ No scripts found in ${path.join(dist, 'index.html')} — run pnpm build first.`],
    };
  const out = files.slice(0, 8).map((f) => `  ${kb(f.gzipBytes).padStart(7)} KB  ${f.file}`);
  const used = Math.round((totalBytes / (budgetKb * 1024)) * 100);
  if (totalBytes > budgetKb * 1024)
    return {
      ok: false,
      out,
      err: [
        `✗ Initial JS is ${kb(totalBytes)} KB gzip, over the ${budgetKb} KB budget. Lazy-load the new dependency (React.lazy / dynamic import) or trim it.`,
      ],
    };
  out.push(
    `✓ Initial JS ${kb(totalBytes)} KB gzip of ${budgetKb} KB (${used}% of budget, ${files.length} files).`,
  );
  return { ok: true, out, err: [] };
}

function main(argv) {
  const dist = path.resolve(argv[0] ?? DEFAULT_DIST);
  const budgetKb = Number(argv[1] ?? DEFAULT_BUDGET_KB);
  const result = checkBundle(dist, budgetKb);
  for (const line of result.out) console.log(line);
  for (const line of result.err) console.error(line);
  return result.ok ? 0 : 1;
}

/** True when this file is the script node was started with — also through a symlinked path (argv[1] isn't resolved). */
function invokedDirectly(argv1, moduleUrl) {
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (process.argv[1] && invokedDirectly(process.argv[1], import.meta.url))
  process.exitCode = main(process.argv.slice(2));
