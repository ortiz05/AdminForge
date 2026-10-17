import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Every AdminForge test lives under tests/. Projects map to the folders in tests/README.md.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    projects: [
      { extends: true, test: { name: 'unit', include: ['unit/**/*.test.ts'], environment: 'node' } },
      {
        extends: true,
        test: {
          name: 'component',
          include: ['component/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./component/setup.ts'],
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
      { extends: true, test: { name: 'content', include: ['content/**/*.test.ts'], environment: 'node' } },
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
