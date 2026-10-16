import { defineConfig } from '@playwright/test';
import { loadEnv } from '@adminforge/config';
import { liveOutDir } from '../lib/output';

// Live validation against a running AdminForge stack and a real tenant (never in CI): `pnpm test:live`.
// Start the stack first (see .claude/skills/validating-against-a-tenant and tests/live/README.md). Results and
// screenshots go to `<AF_LIVE_OUT>/results` (lib/output.ts: private to the user, outside the repository).
const env = loadEnv(process.env, { admin: true });
export default defineConfig({
  testDir: '.',
  // The validation user is disabled between runs: enabled for the run, disabled afterwards.
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  timeout: 240_000,
  workers: 1,
  outputDir: liveOutDir('results'),
  reporter: [['list']],
  use: {
    baseURL: env.PUBLIC_BASE_URL ?? 'http://localhost:5173',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    // Set AF_LIVE_INSECURE_TLS=1 when the stack sits behind a private CA (e.g. Caddy `tls internal` for LAN access).
    ignoreHTTPSErrors: process.env.AF_LIVE_INSECURE_TLS === '1',
  },
});
