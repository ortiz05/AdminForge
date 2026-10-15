import { defineConfig } from '@playwright/test';
import { loadEnv } from '@adminforge/config';

// Live validation against a running AdminForge stack and a real tenant (never in CI).
// Start the stack first (see .claude/skills/validating-against-a-tenant). Output stays outside the repo.
const env = loadEnv(process.env, { admin: true });
export default defineConfig({
  testDir: '.',
  timeout: 240_000,
  workers: 1,
  outputDir: `${process.env.AF_LIVE_OUT ?? '/tmp/adminforge-live'}/results`,
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
