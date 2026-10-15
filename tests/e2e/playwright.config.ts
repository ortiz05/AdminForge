import { defineConfig } from '@playwright/test';

/**
 * Visual + accessibility baseline in mock mode. Every /api and /auth call is answered by page.route
 * (fixtures under e2e/fixtures), so only the Vite dev server is needed. Uses the system Chrome.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  // Production-build smoke tests have their own config (playwright.prod.config.ts).
  testIgnore: 'prod/**',
  outputDir: '../test-results/e2e',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    locale: 'en-GB',
    timezoneId: 'UTC',
  },
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide' },
  },
  webServer: {
    command: 'pnpm --filter @adminforge/web dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
  },
});
