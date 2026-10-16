// Live: executes every datasource of the given pages, dashboards or reports as the validation user (read mode) and
// prints, per datasource, its source and `ok` or the error code with the masked message.
//
// Usage (repository root; the validation user enabled — see tests/live/README.md):
//   pnpm exec tsx tests/live/scripts/check-page-datasources.ts <page key>…   e.g. m365.overview security.overview
// Inputs: page keys (definition ids); the env file and <env>.admin.env for the sign-in.
// Output: `<key>#<datasource> [<source>]: ok | <code>: <message>` — messages masked (lib/mask.ts), cut to 140 chars.
//   Exit code 1 when a page is unknown or a datasource failed.
// Safety: read-only (POST /api/datasources/execute-many runs datasources in read mode, as the portal does).
import { maskError } from '../lib/mask';
import { openPortalSession } from '../lib/portal-session';

const pages = process.argv.slice(2);
if (!pages.length) throw new Error('usage: check-page-datasources.ts <page key>…');
const s = await openPortalSession({ forwardToApi: false });
let failed = 0;
try {
  for (const key of pages) {
    let def: { datasources?: Record<string, { source: string }>; version?: string } | undefined;
    for (const kind of ['page', 'dashboard', 'report']) {
      const r = await s.api<typeof def>('GET', `/api/definitions/${kind}/${encodeURIComponent(key)}`);
      if (r.status === 200) {
        def = r.json;
        break;
      }
    }
    if (!def?.datasources) {
      failed++;
      console.log(`${key}: no definition`);
      continue;
    }
    const r = await s.api<{
      results?: Record<string, { error?: { code: string; message: string; hint?: string } }>;
      error?: { code: string; message: string };
    }>('POST', '/api/datasources/execute-many', {
      page: key,
      version: def.version,
      datasources: Object.keys(def.datasources),
      params: {},
    });
    if (r.status !== 200) {
      failed++;
      console.log(`${key}: http ${r.status} — ${maskError(r.json?.error, { max: 140 })}`);
      continue;
    }
    for (const [ds, res] of Object.entries(r.json?.results ?? {})) {
      if (res.error) failed++;
      console.log(
        `${key}#${ds} [${def.datasources[ds]?.source}]: ${res.error ? maskError(res.error, { max: 140 }) : 'ok'}`,
      );
    }
  }
} finally {
  await s.close();
}
process.exitCode = failed ? 1 : 0;
