// Live: executes every datasource of the given pages as the validation user and prints status + error code per datasource.
// Usage: pnpm exec tsx tests/live/scripts/check-page-datasources.ts m365.overview security.overview
import { openPortalSession } from '../lib/portal-session';

const pages = process.argv.slice(2);
const s = await openPortalSession({ forwardToApi: false });
try {
  for (const key of pages) {
    let def: { datasources?: Record<string, { source: string }>; version?: string } | undefined;
    for (const kind of ['page', 'dashboard', 'report']) {
      const r = await s.api<typeof def>('GET', `/api/definitions/${kind}/${key}`);
      if (r.status === 200) {
        def = r.json;
        break;
      }
    }
    if (!def?.datasources) {
      console.log(key, 'no definition');
      continue;
    }
    const r = await s.api<{
      results: Record<string, { error?: { code: string; message: string; hint?: string } }>;
    }>('POST', '/api/datasources/execute-many', {
      page: key,
      version: def.version,
      datasources: Object.keys(def.datasources),
      params: {},
    });
    for (const [ds, res] of Object.entries(r.json?.results ?? {})) {
      console.log(
        `${key}#${ds} [${def.datasources[ds]?.source}]: ${res.error ? `${res.error.code} — ${res.error.message.slice(0, 140)}` : 'ok'}`,
      );
    }
  }
} finally {
  await s.close();
}
