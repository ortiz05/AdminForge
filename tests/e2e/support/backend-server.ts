/**
 * The real BFF content pipeline as a tiny local process for the e2e suite (started by content-backend.ts with tsx):
 * published content from portal/content, synthetic connector fixtures from tests/fixtures (DATA_MODE=fixtures),
 * real params validation, transforms, saved views and exports. Requests are injected into the Fastify app with a
 * mock session; no network, no database. Prints `PORT=<n>` once listening.
 */
import { createServer } from 'node:http';
import { makeApp, mockConfig, mockLogin } from '../../api/helpers';

const FIXED_NOW = Number(process.env.E2E_FIXED_NOW ?? Date.parse('2026-10-15T14:00:00.000Z'));

// Transforms use the wall clock ($daysUntil, $now); pin it so "days left" and relative states never drift between
// runs (the browser's clock is pinned to the same instant by the specs).
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(FIXED_NOW);
    else super(...(args as [string | number]));
  }
  static override now() {
    return FIXED_NOW;
  }
}
globalThis.Date = FixedDate as DateConstructor;

/** Provenance `ms` comes from the real clock; pin it so footers (and screenshots) are stable. */
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'provenance' && v && typeof v === 'object') {
        const { cachedAt: _c, requestId: _r, ...rest } = v as Record<string, unknown>;
        out[k] = { ...rest, ms: 184 };
      } else out[k] = normalise(v);
    }
    return out;
  }
  return value;
}

const t = await makeApp(mockConfig({ CONTENT_WATCH: 'false', RATE_LIMIT_PER_MINUTE: '100000' }));
t.clock.t = FIXED_NOW;
const { cookie, csrf } = await mockLogin(t.app);

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
    t.app
      .inject({
        method: (req.method ?? 'GET') as 'GET',
        url: req.url ?? '/',
        headers: { cookie, 'x-adminforge-csrf': csrf, ...(body ? { 'content-type': 'application/json' } : {}) },
        payload: body,
      })
      .then((r) => {
        const type = String(r.headers['content-type'] ?? '');
        const headers: Record<string, string> = {};
        for (const h of ['content-type', 'content-disposition', 'x-correlation-id']) if (r.headers[h] !== undefined) headers[h] = String(r.headers[h]);
        res.writeHead(r.statusCode, headers);
        res.end(type.includes('application/json') ? JSON.stringify(normalise(r.json())) : r.rawPayload);
      })
      .catch((err: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'e2e_backend', message: String(err) } }));
      });
  });
});
server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  process.stdout.write(`PORT=${typeof addr === 'object' && addr ? addr.port : 0}\n`);
});
