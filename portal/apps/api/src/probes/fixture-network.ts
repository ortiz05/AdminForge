import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createFixtureFetch } from '@adminforge/connectors';
import { AppError } from '../errors';
import type { HostLookup } from './addresses';
import type { DnsResolver, PeerCertificate, TlsInspector } from './checks';

/**
 * DATA_MODE=fixtures: the network probes would use, answered from the fixtures directory (ADMINFORGE_FIXTURES_DIR,
 * normally tests/fixtures) — nothing resolves, connects or sends from this host (schedules/module.ts wires it).
 *
 *   HTTP    the fixture fetch: `hosts/<host>/<path>/<METHOD>[__<query>].json` (naming and `$fixture` variants:
 *           connectors/src/fixtures.ts). The portal's own origin (PUBLIC_BASE_URL, whatever its host and port) is
 *           answered as `hosts/portal.example.com/…`.
 *   lookup  the HTTP probes' SSRF guard: `dns/<host>/A.json` and `AAAA.json` when there are any, else a synthetic public
 *           address — so the guard still runs (a fixture answering a private address shows it refusing).
 *   DNS     `dns/<name>/<TYPE>.json`: the answers as text, as the resolver gives them (`["v=spf1 include:… -all"]`; MX
 *           exchanges by preference; SRV `target:port`), or `{ "error": "ENOTFOUND" }` for a name that doesn't exist.
 *   TLS     `tls/<host>/<port>.json`: `{ "expiresInDays", "issuedDaysAgo", "authorized", "authorizationError",
 *           "subject", "issuer" }` — dates relative to the probe's clock, so a fixture never expires. The portal's own
 *           host is answered as `tls/portal.example.com/<port>.json`.
 * Host names are lower-cased; characters outside [a-z0-9._-] become "_". A check without a fixture fails with
 * `fixture_not_found`, one whose fixture isn't JSON with `fixture_invalid` (status `error`: the probe could not
 * evaluate) — never a made-up crit — and neither names a file.
 */

/** The host the portal's own origin is answered as. */
export const PORTAL_FIXTURE_HOST = 'portal.example.com';
/** The SSRF guard's answer for a host without A/AAAA fixtures: public, so the guard's checks still run. */
export const FIXTURE_ADDRESS = '1.1.1.1';

export interface FixtureNetwork {
  fetch: typeof fetch;
  lookup: HostLookup;
  dns: DnsResolver;
  tls: TlsInspector;
}

const DAY_MS = 86_400_000;
const segment = (s: string) => {
  const out = s
    .toLowerCase()
    .replace(/\.+$/, '')
    .replace(/[^a-z0-9._-]/g, '_');
  return !out || out === '.' || out === '..' ? '_' : out;
};

const missing = (what: string) =>
  new AppError(404, 'fixture_not_found', `The synthetic data has no answer for this ${what}.`, {
    hint: 'Add a fixture for it (Testing guide › Fixtures), or turn the probe off.',
  });
/** A fixture that isn't valid JSON: the check could not evaluate (never a crit), and the message names no file. */
const invalid = (what: string) =>
  new AppError(500, 'fixture_invalid', `The synthetic answer for this ${what} is not valid JSON.`, {
    hint: 'Fix the fixture you added for it (Testing guide › Fixtures).',
  });

/** The fixture network over `dir`. `publicBaseUrl` is the portal's own origin (answered as PORTAL_FIXTURE_HOST). */
export function createFixtureNetwork(opts: {
  dir: string;
  publicBaseUrl: string;
  now: () => Date;
}): FixtureNetwork {
  const root = path.resolve(opts.dir);
  const own = (() => {
    try {
      return new URL(opts.publicBaseUrl);
    } catch {
      return undefined;
    }
  })();
  const fixtures = createFixtureFetch(root);

  /** `<kind>/<name>/<file>` (the name sanitised; the file a record type or a port: `MX.json`, `443.json`). */
  async function load(kind: 'dns' | 'tls', name: string, leaf: string): Promise<unknown> {
    if (!/^[A-Za-z0-9]+\.json$/.test(leaf)) return undefined;
    const file = path.resolve(root, kind, segment(name), leaf);
    if (!file.startsWith(root + path.sep)) return undefined;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') return undefined;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw invalid(kind === 'dns' ? 'DNS check' : 'certificate check');
    }
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    let url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (own && url.origin === own.origin)
      url = new URL(`${url.pathname}${url.search}`, `https://${PORTAL_FIXTURE_HOST}`);
    let res: Response;
    try {
      res = await fixtures(url.href, init);
    } catch {
      throw invalid('HTTP check'); // the fixture fetch refuses a file that isn't JSON (its message names the file)
    }
    if (res.status === 404) {
      const body = (await res
        .clone()
        .json()
        .catch(() => null)) as { error?: { code?: string } } | null;
      if (body?.error?.code === 'FixtureNotFound') {
        await res.body?.cancel().catch(() => undefined);
        throw missing('HTTP check');
      }
    }
    return res;
  }) as typeof fetch;

  const lookup: HostLookup = async (host) => {
    const found: string[] = [];
    for (const type of ['A', 'AAAA']) {
      const answers = await load('dns', host, `${type}.json`);
      if (Array.isArray(answers)) found.push(...answers.map(String));
    }
    return found.length ? found : [FIXTURE_ADDRESS];
  };

  const dns: DnsResolver = {
    async resolve(name, type) {
      const answer = await load('dns', name, `${type}.json`);
      if (answer === undefined) throw missing('DNS check');
      if (Array.isArray(answer)) return answer.map(String);
      const code = (answer as { error?: unknown }).error;
      throw Object.assign(new Error(`Fixture answer for ${type} ${name}: ${String(code)}`), {
        code: typeof code === 'string' ? code : 'ESERVFAIL',
      });
    },
  };

  const tls: TlsInspector = {
    async inspect({ host, port }) {
      const name = own && host.toLowerCase() === own.hostname.toLowerCase() ? PORTAL_FIXTURE_HOST : host;
      const f = (await load('tls', name, `${port}.json`)) as
        | {
            expiresInDays?: number;
            issuedDaysAgo?: number;
            authorized?: boolean;
            authorizationError?: string;
            subject?: string;
            issuer?: string;
          }
        | undefined;
      if (!f || typeof f !== 'object') throw missing('certificate check');
      const now = opts.now().getTime();
      const cert: PeerCertificate = {
        validFrom: new Date(now - (f.issuedDaysAgo ?? 30) * DAY_MS),
        validTo: new Date(now + (f.expiresInDays ?? 90) * DAY_MS),
        authorized: f.authorized ?? true,
        ...(f.authorizationError ? { authorizationError: f.authorizationError } : {}),
        ...(f.subject ? { subject: f.subject } : {}),
        ...(f.issuer ? { issuer: f.issuer } : {}),
      };
      return cert;
    },
  };

  return { fetch: fetchImpl, lookup, dns, tls };
}
