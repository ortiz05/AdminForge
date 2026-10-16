#!/usr/bin/env node
/**
 * Claude Code after-edit hook: fast feedback that mirrors the CI rules for the one file Claude just wrote.
 *
 * Wired in .claude/settings.json as a PostToolUse hook on Write|Edit. Claude Code passes the tool call as JSON on stdin
 * (`tool_input.file_path`, `tool_response.filePath`). Exit 2 with problems on stderr = feedback Claude sees and acts
 * on; exit 0 = nothing to report. It never blocks on its own failures (a missing pnpm, a timeout): CI is the authority.
 *
 * Per file (see checksFor):
 *   - code and docs (.ts .tsx .js .mjs .json .css .md, not content/fixtures/plans): Prettier --write (best effort)
 *   - content definitions (portal/content/**.yaml) and runner scripts (portal/content/scripts/**.ps1):
 *     `adminforge validate` — schema, references, expressions, lint, and the runner script sha256 pins, so editing a
 *     script lists every definition whose pin is now stale (with the new sha256)
 *   - UI code: raw colours and arbitrary Tailwind values (tooling/lint/design-token-patterns.mjs, shared with ESLint
 *     and tests/guards/design-tokens.test.ts)
 *
 * The decisions are pure exported functions with the I/O injected, so tests/unit/tooling/after-edit-hook.test.ts can
 * check them with fakes; running the file directly is the hook.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTokenViolations, isUiFile, MESSAGES } from '../../tooling/lint/design-token-patterns.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const FORMATTED = /\.(ts|tsx|js|mjs|json|css|md)$/;
// Content YAML and fixtures are hand-laid-out data; plans are working notes.
const NOT_FORMATTED = /^(portal\/content|tests\/fixtures|docs\/plans)\//;
const CONTENT_DEFINITION = /^portal\/content\/.+\.ya?ml$/;
const CONTENT_SCRIPT = /^portal\/content\/scripts\/.+\.ps1$/;

/**
 * The repository-relative path (`/`-separated) of the file a Write/Edit hook call touched, or null when there is
 * none or it lies outside the repository.
 * @param {unknown} input  the parsed hook payload
 * @param {string} [root]
 * @returns {string | null}
 */
export function editedFile(input, root = REPO_ROOT) {
  const payload =
    /** @type {{ tool_response?: { filePath?: unknown }; tool_input?: { file_path?: unknown } }} */ (
      input ?? {}
    );
  const file = payload.tool_response?.filePath ?? payload.tool_input?.file_path;
  if (typeof file !== 'string' || !file) return null;
  const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
}

/**
 * Which checks apply to a repository-relative path.
 * @param {string} rel
 * @returns {{ prettier: boolean; validate: boolean; designTokens: boolean }}
 */
export function checksFor(rel) {
  return {
    prettier: FORMATTED.test(rel) && !NOT_FORMATTED.test(rel),
    validate: CONTENT_DEFINITION.test(rel) || CONTENT_SCRIPT.test(rel),
    designTokens: isUiFile(rel),
  };
}

/**
 * The part of a failed `adminforge validate` worth showing: its `✗` lines (errors, e.g. a stale script pin, and the
 * summary) — warnings would otherwise push them out — or, when there are none (a crash), the end of the output.
 * At most 40 lines.
 * @param {string} output  stdout + stderr
 * @returns {string}
 */
export function validateFeedback(output) {
  const lines = output.trim().split('\n');
  const errors = lines.filter((l) => l.startsWith('✗'));
  return (errors.length ? errors.slice(0, 40) : lines.slice(-40)).join('\n');
}

/**
 * @typedef {object} HookDeps
 * @property {(cmd: string, args: string[], timeoutMs: number) => void} run  runs a command in the repository root;
 *   throws (with `stdout`/`stderr`) when it fails
 * @property {(rel: string) => Buffer} readFile
 */

/**
 * Runs the checks for one edited file and returns the problems to report (empty = nothing to say).
 * @param {string} rel
 * @param {HookDeps} deps
 * @returns {string[]}
 */
export function runChecks(rel, deps) {
  const checks = checksFor(rel);
  const problems = [];

  if (checks.prettier) {
    try {
      deps.run('pnpm', ['-s', 'exec', 'prettier', '--write', '--log-level', 'warn', rel], 60_000);
    } catch {
      // Formatting is best effort here; CI's format:check is authoritative.
    }
  }

  if (checks.validate) {
    try {
      deps.run('pnpm', ['-s', 'adminforge', 'validate'], 120_000);
    } catch (err) {
      const e = /** @type {{ stdout?: unknown; stderr?: unknown }} */ (err ?? {});
      problems.push(
        `adminforge validate failed after editing ${rel}:\n${validateFeedback(`${e.stdout ?? ''}${e.stderr ?? ''}`)}`,
      );
    }
  }

  if (checks.designTokens) {
    for (const v of findTokenViolations(deps.readFile(rel).toString('utf8')))
      problems.push(`${rel}:${v.line}: ${MESSAGES[v.kind]}`);
  }

  return problems;
}

/** The real file system and processes, rooted at the repository. */
function realDeps(root) {
  return {
    run: (cmd, args, timeoutMs) => {
      execFileSync(cmd, args, { cwd: root, stdio: 'pipe', timeout: timeoutMs });
    },
    readFile: (rel) => readFileSync(path.join(root, rel)),
  };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return 0;
  }
  const rel = editedFile(input);
  if (!rel) return 0;
  const problems = runChecks(rel, realDeps(REPO_ROOT));
  if (!problems.length) return 0;
  process.stderr.write(`${problems.join('\n')}\n`);
  return 2;
}

/** True when this file is the script node was started with — also through a symlinked path (argv[1] isn't resolved). */
function invokedDirectly(argv1, moduleUrl) {
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (process.argv[1] && invokedDirectly(process.argv[1], import.meta.url)) process.exit(main());
