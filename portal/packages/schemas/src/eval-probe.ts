import { z } from 'zod';

/**
 * For browser bundles under AdminForge's Content-Security-Policy (`script-src 'self'`, no `unsafe-eval`). Zod 4 tries
 * `Function('')` once to decide whether to compile its validators; the policy blocks it, Zod falls back, and the
 * browser logs a CSP violation on every page load — noise that hides real problems. Turning compilation off up front
 * skips the probe; validation behaves the same. Call before any schema parses (the web app's first import). The API
 * keeps compiled validators: it has no such policy.
 */
export function disableEvalProbe(): void {
  z.config({ jitless: true });
}
