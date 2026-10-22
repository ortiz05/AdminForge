import { isIP } from 'node:net';
import { AppError } from '../errors';
import { defaultLookup, isNonPublicAddress } from './addresses';
import type { CheckContext } from './checks';

/**
 * Where probes may connect (SSRF, SECURITY.md): HTTP and certificate probes reach this portal's own host or hosts
 * that resolve only to public addresses; DNS probes ask the system resolver, a public one, or one an administrator
 * listed in AF_PROBE_RESOLVERS.
 */

export const targetNotAllowed = (why: string) =>
  new AppError(400, 'probe_target_not_allowed', `The probe URL ${why}.`, {
    hint: 'HTTP probes check public endpoints (or this portal itself). Point the probe at a public https URL.',
  });

/**
 * SSRF guard for HTTP probes: the portal's own origin is always allowed; anything else must be http(s) on the default
 * port range and resolve only to public addresses (no loopback, LAN, link-local or cloud metadata). True for the own
 * origin.
 */
export async function assertProbeTarget(url: URL, x: CheckContext): Promise<boolean> {
  const own = (() => {
    try {
      return new URL(String(x.deps.env().PUBLIC_BASE_URL ?? '')).origin;
    } catch {
      return undefined;
    }
  })();
  if (own && url.origin === own) return true;
  if (url.username || url.password) throw targetNotAllowed('contains credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host || /^localhost$/i.test(host) || /\.localhost$/i.test(host))
    throw targetNotAllowed('points at this host');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await (x.deps.lookup ?? defaultLookup)(host);
  } catch (err) {
    if (err instanceof AppError) throw err; // the lookup could not evaluate (e.g. a broken fixture), not a DNS answer
    const code = (err as { code?: string }).code;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: code ?? 'ENOTFOUND' } });
  }
  if (!addresses.length || addresses.some(isNonPublicAddress))
    throw targetNotAllowed('resolves to a private, loopback or link-local address');
  return false;
}

/** The portal's own host (PUBLIC_BASE_URL), which probes may always reach. */
function ownHost(x: CheckContext): string | undefined {
  try {
    return new URL(String(x.deps.env().PUBLIC_BASE_URL ?? '')).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The port PUBLIC_BASE_URL serves on (443 when it names none). */
function ownPort(x: CheckContext): number | undefined {
  try {
    const url = new URL(String(x.deps.env().PUBLIC_BASE_URL ?? ''));
    return url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443;
  } catch {
    return undefined;
  }
}

/**
 * The same rule for certificate probes as for HTTP probes: this portal's own host, or a host that resolves only to
 * public addresses — no loopback, LAN, link-local or cloud metadata. Returns the address to connect to (the one checked,
 * so the connection can't be re-pointed by a second DNS answer), or undefined for this portal's own host.
 */
export async function assertCertTarget(
  host: string,
  port: number,
  x: CheckContext,
): Promise<string | undefined> {
  const bare = host
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();
  // This portal itself, on its own port or 443 (its TLS endpoint when a proxy fronts it): another port on the same
  // host is a different service.
  if (bare === ownHost(x) && (port === ownPort(x) || port === 443)) return undefined;
  const refused = new AppError(
    400,
    'probe_target_not_allowed',
    `The certificate probe's host ${bare} is this host or resolves to a private, loopback or link-local address.`,
    {
      hint: 'Certificate probes check public hosts (or this portal itself). Point the probe at a public host name.',
    },
  );
  if (!bare || /^localhost$/i.test(bare) || /\.localhost$/i.test(bare)) throw refused;
  const addresses = isIP(bare) ? [bare] : await (x.deps.lookup ?? defaultLookup)(bare);
  if (!addresses.length || addresses.some(isNonPublicAddress)) throw refused;
  return addresses[0];
}

/**
 * A DNS probe's resolver: the system's when the probe names none; otherwise an IP address — a public one, or one an
 * administrator listed in AF_PROBE_RESOLVERS (the organization's own resolvers). A host name or another private
 * address would let content send queries anywhere on the network.
 */
export function assertResolver(resolver: string | undefined, x: CheckContext): void {
  if (!resolver) return;
  const listed = String(x.deps.env().AF_PROBE_RESOLVERS ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (listed.includes(resolver)) return;
  if (!isIP(resolver) || isNonPublicAddress(resolver))
    throw new AppError(
      400,
      'probe_target_not_allowed',
      `The DNS probe's resolver ${resolver} isn't a public IP address or one listed for probes.`,
      {
        hint: 'Name a public resolver by IP address, leave it out to use the system resolver, or ask an administrator to list your own resolver in AF_PROBE_RESOLVERS.',
      },
    );
}
