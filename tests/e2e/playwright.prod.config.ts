import { defineConfig } from '@playwright/test';

/**
 * Production-build smoke: the same mocked API as the main e2e suite, but served from `vite preview` (the built
 * `dist/`). Catches what only the bundler breaks — tree-shaken side effects, chunking, minification — which the dev
 * server never shows. Run `pnpm build` first (CI does).
 */
export default defineConfig({
  testDir: './prod',
  testMatch: '**/*.spec.ts',
  outputDir: '../test-results/e2e-prod',
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4174',
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    locale: 'en-GB',
    timezoneId: 'UTC',
  },
  webServer: {
    command: 'pnpm --filter @adminforge/web exec vite preview --port 4174 --strictPort',
    url: 'http://localhost:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
  },
});
