import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * `*.scale.test.ts` (any folder): tests that hold transforms and native helpers to the API's 250 ms wall-clock budget
 * at enterprise size. They run in the `scale` project — after the others and one file at a time (`pnpm test`) — so
 * another project's files can't take the CPU and fail a budget.
 */
const SCALE = '**/*.scale.test.ts';

/**
 * `*.pwsh.test.ts` (any folder): tests that start real PowerShell (`pwsh`: the runner's workers, Pester). They run in
 * the `pwsh` project (`pnpm test` includes it; alone: `pnpm --filter @adminforge/tests test:pwsh`) and skip where pwsh
 * isn't installed, so `--project unit` stays fast and needs nothing but Node.
 */
const PWSH = '**/*.pwsh.test.ts';

/**
 * Per-test limit for the projects that run many files in parallel (unit, component, content). Vitest's 5 s default
 * failed tests that load the whole content tree, spawn processes or drive `userEvent` through jsdom whenever the
 * machine was busy (they took 3.5–5 s); 15 s absorbs that load and still stops a test that hangs.
 */
const PARALLEL_TEST_TIMEOUT = 15_000;

// Every AdminForge test lives under tests/. Projects map to the folders in tests/README.md.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['unit/**/*.test.ts'],
          exclude: [SCALE, PWSH],
          environment: 'node',
          testTimeout: PARALLEL_TEST_TIMEOUT,
        },
      },
      {
        extends: true,
        test: {
          name: 'component',
          include: ['component/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./component/setup.ts'],
          testTimeout: PARALLEL_TEST_TIMEOUT,
        },
      },
      {
        extends: true,
        test: {
          name: 'api',
          include: ['api/**/*.test.ts'],
          exclude: [SCALE, PWSH],
          environment: 'node',
          setupFiles: ['./api/setup.ts'],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'content',
          include: ['content/**/*.test.ts'],
          exclude: [SCALE, PWSH],
          environment: 'node',
          testTimeout: PARALLEL_TEST_TIMEOUT,
        },
      },
      {
        extends: true,
        test: {
          name: 'scale',
          include: [SCALE],
          environment: 'node',
          fileParallelism: false,
        },
      },
      {
        extends: true,
        // Each test starts pwsh, which takes seconds on a busy machine; the long ones (Pester) set their own limit.
        test: { name: 'pwsh', include: [PWSH], environment: 'node', testTimeout: 60_000 },
      },
      {
        extends: true,
        test: {
          name: 'guards',
          include: ['guards/**/*.test.ts'],
          exclude: [SCALE, PWSH],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: { name: 'live', include: ['live/**/*.test.ts'], environment: 'node', testTimeout: 60_000 },
      },
      // Enterprise-scale budgets against the synthetic tenant (tests/perf/README.md): `pnpm test:perf` only — not
      // part of `pnpm test`; the suite skips itself unless AF_PERF=1.
      {
        extends: true,
        test: {
          name: 'perf',
          include: ['perf/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 900_000,
          hookTimeout: 900_000,
          execArgv: ['--max-old-space-size=8192', '--expose-gc'],
        },
      },
    ],
  },
});
