#!/usr/bin/env node
// PostToolUse hook (Write|Edit): fast feedback that mirrors CI rules for the file just edited.
// Exit 2 + stderr = feedback Claude sees and acts on. Exit 0 = nothing to report.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}
const file = input.tool_response?.filePath ?? input.tool_input?.file_path;
if (!file) process.exit(0);
const rel = path.relative(root, path.resolve(file)).split(path.sep).join('/');
if (rel.startsWith('..')) process.exit(0);

const problems = [];

// 1. Content definitions: schema, references, expressions, lint.
if (/^portal\/content\/.+\.ya?ml$/.test(rel)) {
  try {
    execFileSync('pnpm', ['-s', 'adminforge', 'validate'], { cwd: root, stdio: 'pipe', timeout: 120_000 });
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
    problems.push(`adminforge validate failed after editing ${rel}:\n${out}`);
  }
}

// 2. UI code: design tokens only (same rules as tests/guards/design-tokens.test.ts).
if (/^portal\/(apps\/web\/src|packages\/(ui|widgets)\/src)\/.+\.(tsx?|css)$/.test(rel)) {
  const RAW = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])|\brgba?\(|\bhsla?\(|\boklch\(/;
  const ARB = /\b[a-z][a-z-]*-\[[^\]\s]+\]/;
  readFileSync(path.join(root, rel), 'utf8').split('\n').forEach((line, i) => {
    if (RAW.test(line)) problems.push(`${rel}:${i + 1}: raw colour — use a design token (bg-panel, text-fg-2, var(--af-…)).`);
    if (ARB.test(line)) problems.push(`${rel}:${i + 1}: arbitrary Tailwind value — use a token or add one in design-tokens.`);
  });
}

// 3. Runner scripts: their sha256 is pinned in content; list references that are now stale.
if (/^portal\/content\/scripts\/.+\.ps1$/.test(rel)) {
  const scriptPath = rel.replace(/^portal\/content\/scripts\//, '');
  const sha = createHash('sha256').update(readFileSync(path.join(root, rel))).digest('hex');
  const stale = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(name)) {
        const text = readFileSync(p, 'utf8');
        if (text.includes(scriptPath) && !text.includes(sha)) stale.push(path.relative(root, p));
      }
    }
  };
  walk(path.join(root, 'portal/content'));
  if (stale.length) problems.push(`${rel} changed; its new sha256 is ${sha}. Update the pinned sha256 in:\n  ${stale.join('\n  ')}`);
}

if (problems.length) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exit(2);
}
