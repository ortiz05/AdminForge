import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoRoot } from '../../lib/repo';

// `pnpm typecheck` is a check, not a build (O-11). It used to depend on `^build`, so it rebuilt the web app, the API,
// the runner, the scheduler and the CLI first — and a checkout a running service serves (WEB_DIST_DIR, `dist/main.js`)
// changed under it. The packages are consumed as TypeScript source (`exports` point at `src`), so no typecheck needs
// a build output. The one generated file a typecheck reads is the web app's route tree (git-ignored), which the
// tests package type-checks through the router: `typecheck` depends on the dependencies' `routes` task only. The
// build outputs that are really consumed keep their dependency: the web build and dev server import the CSS that
// the design-tokens build writes.
type Task = { taskId: string; task: string; package: string; command: string; dependencies: string[] };

const turbo = path.join(repoRoot, 'node_modules/.bin/turbo');
const config = JSON.parse(readFileSync(path.join(repoRoot, 'turbo.json'), 'utf8')) as {
  tasks: Record<string, { dependsOn?: string[] }>;
};

/** The task graph `turbo run <task>` would execute (a dry run: nothing runs, nothing is cached). */
function plan(task: string, ...filters: string[]): Task[] {
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'af-turbo-'));
  try {
    const out = execFileSync(
      turbo,
      ['run', task, '--dry=json', `--cache-dir=${cacheDir}`, ...filters.map((f) => `--filter=${f}`)],
      { cwd: repoRoot, env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' }, maxBuffer: 64 * 1024 * 1024 },
    );
    return (JSON.parse(out.toString('utf8')) as { tasks: Task[] }).tasks;
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

/** Tasks that would really run a script (turbo lists tasks of packages without that script as <NONEXISTENT>). */
const real = (tasks: Task[]) => tasks.filter((t) => t.command !== '<NONEXISTENT>');

describe('turbo task graph', () => {
  it('typecheck depends on no build task', () => {
    const deps = config.tasks.typecheck?.dependsOn ?? [];
    expect(deps.filter((d) => /(^|[#^])(build|dev)$/.test(d))).toEqual([]);
  });

  it('`pnpm typecheck` runs typechecks and the route generator, never a build', { timeout: 30_000 }, () => {
    const tasks = real(plan('typecheck'));
    expect(tasks.filter((t) => t.task !== 'typecheck' && t.task !== 'routes').map((t) => t.taskId)).toEqual(
      [],
    );
    expect(tasks.filter((t) => t.task === 'typecheck').length).toBeGreaterThan(10);
  });

  it('the tests package type-checks after the web route tree is generated', { timeout: 30_000 }, () => {
    const tests = plan('typecheck').find((t) => t.taskId === '@adminforge/tests#typecheck');
    expect(tests?.dependencies).toContain('@adminforge/web#routes');
  });

  it('the web build and dev server still get the design-tokens CSS first', { timeout: 30_000 }, () => {
    for (const task of ['build', 'dev']) {
      const web = plan(task, '@adminforge/web').find((t) => t.taskId === `@adminforge/web#${task}`);
      expect(web?.dependencies, task).toContain('@adminforge/design-tokens#build');
    }
  });
});
