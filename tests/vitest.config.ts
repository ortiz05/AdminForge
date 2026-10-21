import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Tests that hold transforms and native helpers to the API's 250 ms wall-clock budget at enterprise size. They run in
 * the `scale` project — after the others and one file at a time (`pnpm test`) — so another project's files can't take
 * the CPU and fail a budget.
 */
const SCALE = [
  'content/content-at-scale*.test.ts',
  'unit/expressions/group-by.test.ts',
  'unit/expressions/order-by.test.ts',
  'unit/expressions/rows-helpers.test.ts',
  'unit/expressions/rows-join-helpers.test.ts',
  'unit/expressions/limits.test.ts',
  'unit/expressions/native-paths-hardening.test.ts',
  'unit/expressions/table-rows.test.ts',
  'unit/api/datasource-scale.test.ts',
];

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
          exclude: SCALE,
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
          exclude: SCALE,
          environment: 'node',
          testTimeout: PARALLEL_TEST_TIMEOUT,
        },
      },
      {
        extends: true,
        test: {
          name: 'scale',
          include: SCALE,
          environment: 'node',
          fileParallelism: false,
        },
      },
      { extends: true, test: { name: 'guards', include: ['guards/**/*.test.ts'], environment: 'node' } },
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
