#!/usr/bin/env node
/**
 * Commit message and pull-request title check (docs/onboarding/10-git-and-pull-requests.md).
 *
 *   node tooling/git/commit-message.mjs <file>            # the commit-msg hook (.githooks/commit-msg)
 *   node tooling/git/commit-message.mjs --title "<text>"  # CI: the pull request title, which becomes the squash commit
 *
 * Headers follow Conventional Commits: `<type>(<scope>[,<scope>]): <summary>` with the types and scopes below. Merge,
 * revert and autosquash (`fixup!`, `squash!`, `amend!`) commits pass locally; a pull request title must be a real header
 * or GitHub's `Revert "<header>"` (what its Revert button writes).
 */

export const TYPES = ['feat', 'fix', 'docs', 'test', 'refactor', 'perf', 'chore', 'ci', 'build', 'revert'];

/** Packages, apps and cross-cutting areas. Add a scope here (and to the onboarding guide) when a new area appears. */
export const SCOPES = [
  // apps and packages
  'api',
  'web',
  'scheduler',
  'runner',
  'cli',
  'ui',
  'widgets',
  'engine',
  'connectors',
  'schemas',
  'expressions',
  'design-tokens',
  'config',
  // content and features
  'content',
  'news',
  'reports',
  'schedules',
  'runs',
  'query',
  'audit',
  // cross-cutting
  'auth',
  'security',
  'ux',
  'deploy',
  'dev',
  'deps',
  'docs',
  'plan',
  'tests',
  'e2e',
  'live',
];

export const MAX_HEADER = 100;

const HEADER = /^([a-z]+)(?:\(([^)]*)\))?(!)?: (.*)$/;
const PASS_LOCALLY = /^(Merge |Revert "|fixup! |squash! |amend! )/;
const REVERT_TITLE = /^Revert "(.+)"$/;
const SCISSORS = /^# -+ >8 -+$/m;

/** The message as git records it: everything below the scissors line and comment lines removed. */
export function cleanMessage(raw) {
  const cut = raw.search(SCISSORS);
  return (cut === -1 ? raw : raw.slice(0, cut))
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim();
}

/**
 * Problems with a commit message (or, with `title: true`, a pull request title); an empty list means it is fine.
 * @param {string} raw
 * @param {{ title?: boolean }} [opts]
 * @returns {string[]}
 */
export function checkCommitMessage(raw, opts = {}) {
  const message = opts.title ? raw.trim() : cleanMessage(raw);
  if (!message) return ['The message is empty.'];
  const [header = '', second] = message.split('\n');
  if (opts.title && message.includes('\n')) return ['A pull request title is one line.'];
  if (!opts.title && PASS_LOCALLY.test(header)) return [];
  const revert = opts.title ? REVERT_TITLE.exec(header) : null;
  if (revert) return checkCommitMessage(revert[1], { title: true });

  const problems = [];
  const m = HEADER.exec(header);
  if (!m) {
    problems.push(
      `The first line must look like "<type>(<scope>): <summary>" or "<type>: <summary>", e.g. "fix(api): refuse expired approvals". Got: "${header}".`,
    );
    return problems;
  }
  const [, type, scopes, , summary] = m;
  if (!TYPES.includes(type)) problems.push(`Unknown type "${type}". Use one of: ${TYPES.join(', ')}.`);
  if (scopes !== undefined) {
    const list = scopes.split(',');
    const unknown = list.filter((s) => !SCOPES.includes(s));
    if (!scopes || unknown.length)
      problems.push(
        `Unknown scope${unknown.length > 1 ? 's' : ''} "${unknown.join(',') || scopes}". Use one or more (comma-separated, no spaces) of: ${SCOPES.join(', ')} — or leave the scope out.`,
      );
  }
  if (!summary.trim()) problems.push('The summary after ": " is empty.');
  else {
    if (/^\s/.test(summary)) problems.push('Put exactly one space after the colon.');
    if (/[.]$/.test(summary)) problems.push('Leave the full stop off the end of the summary.');
  }
  if (header.length > MAX_HEADER)
    problems.push(
      `The first line is ${header.length} characters; keep it to ${MAX_HEADER} (aim for 72) and put detail in the body.`,
    );
  if (second !== undefined && second.trim() !== '')
    problems.push('Leave the second line blank: the body starts on line three.');
  return problems;
}

async function main(argv) {
  const { readFileSync } = await import('node:fs');
  const titleAt = argv.indexOf('--title');
  const title = titleAt !== -1;
  const text = title ? (argv[titleAt + 1] ?? '') : argv[0] ? readFileSync(argv[0], 'utf8') : '';
  const problems = checkCommitMessage(text, { title });
  if (!problems.length) return 0;
  const what = title ? 'Pull request title' : 'Commit message';
  console.error(`${what} doesn't follow the convention (docs/onboarding/10-git-and-pull-requests.md):`);
  for (const p of problems) console.error(`  - ${p}`);
  if (!title) console.error('Your message was kept in .git/COMMIT_EDITMSG; fix it and commit again.');
  return 1;
}

const { fileURLToPath } = await import('node:url');
const { realpathSync } = await import('node:fs');
/** True when this file is the script node was started with — also through a symlinked path (argv[1] isn't resolved). */
function invokedDirectly(argv1, moduleUrl) {
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (process.argv[1] && invokedDirectly(process.argv[1], import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
