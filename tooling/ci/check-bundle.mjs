#!/usr/bin/env node
// Initial-load budget (plan §6.10): the JavaScript a first visit downloads before anything lazy — the entry module,
// its modulepreloads and classic scripts in index.html — must stay at or under the gzip budget.
// Usage: node tooling/ci/check-bundle.mjs [distDir] [budgetKB]   (after `pnpm build`)
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = path.resolve(process.argv[2] ?? 'portal/apps/web/dist');
const budgetKb = Number(process.argv[3] ?? 250);
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const files = new Set();
for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+\.js)"/g)) files.add(m[1]);
for (const m of html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+\.js)"/g)) files.add(m[1]);
if (!files.size) {
  console.error(`✗ No scripts found in ${path.join(dist, 'index.html')} — run pnpm build first.`);
  process.exit(1);
}
let total = 0;
const rows = [];
for (const f of files) {
  const abs = path.join(dist, f.replace(/^\//, ''));
  statSync(abs);
  const gz = gzipSync(readFileSync(abs), { level: 9 }).length;
  total += gz;
  rows.push([f, gz]);
}
rows.sort((a, b) => b[1] - a[1]);
const kb = (n) => (n / 1024).toFixed(1);
for (const [f, gz] of rows.slice(0, 8)) console.log(`  ${kb(gz).padStart(7)} KB  ${f}`);
const used = Math.round((total / (budgetKb * 1024)) * 100);
if (total > budgetKb * 1024) {
  console.error(
    `✗ Initial JS is ${kb(total)} KB gzip, over the ${budgetKb} KB budget. Lazy-load the new dependency (React.lazy / dynamic import) or trim it.`,
  );
  process.exit(1);
}
console.log(`✓ Initial JS ${kb(total)} KB gzip of ${budgetKb} KB (${used}% of budget, ${files.size} files).`);
