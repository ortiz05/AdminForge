import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Address classification for HTTP probes and public news feeds (SSRF guard): a probe or feed may not reach this host's
 * loopback, the LAN, link-local addresses (cloud metadata at 169.254.169.254), documentation/benchmark ranges, or an
 * IPv6 form that embeds or tunnels to one of those (IPv4-mapped/translated/compatible, NAT64, 6to4, Teredo) — except the
 * portal's own origin for probes.
 */

/** Resolves a host name to every address it has (A and AAAA), or the literal itself. */
export type HostLookup = (host: string) => Promise<string[]>;

export const defaultLookup: HostLookup = async (host) => {
  if (isIP(host)) return [host];
  const answers = await lookup(host, { all: true, verbatim: true });
  return answers.map((a) => a.address);
};

function v4Parts(ip: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : undefined;
}

function nonPublicV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments; TEST-NET-1 (documentation)
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast (deprecated)
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2 (documentation)
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3 (documentation)
    a! >= 224 // multicast, reserved, broadcast
  );
}

/** Eight 16-bit groups of an IPv6 address (an embedded dotted IPv4 tail included), or undefined. */
function v6Groups(ip: string): number[] | undefined {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const p = v4Parts(tail[1]!);
    if (!p) return undefined;
    s = `${s.slice(0, -tail[1]!.length)}${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return groups.map((g) => parseInt(g, 16));
}

const v4From = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

/** True for loopback, private, link-local, unique-local, multicast and other non-public addresses (and junk). */
export function isNonPublicAddress(ip: string): boolean {
  const v4 = v4Parts(ip);
  if (v4) return nonPublicV4(v4);
  const g = v6Groups(ip.replace(/^\[|\]$/g, ''));
  if (!g) return true;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(8)) return true; // ::
  if (zeroTo(7) && h7 === 1) return true; // ::1
  if (zeroTo(5) && h5 === 0xffff) return nonPublicV4(v4From(h6, h7)); // ::ffff:a.b.c.d (IPv4-mapped)
  if (zeroTo(4) && h4 === 0xffff && h5 === 0) return nonPublicV4(v4From(h6, h7)); // ::ffff:0:a.b.c.d (SIIT-translated)
  if (zeroTo(6)) return nonPublicV4(v4From(h6, h7)); // ::a.b.c.d (deprecated compatible form)
  if (h0 === 0x64 && h1 === 0xff9b && !h2 && !h3 && !h4 && !h5) return nonPublicV4(v4From(h6, h7)); // NAT64 64:ff9b::/96
  if (h0 === 0x64 && h1 === 0xff9b && h2 === 1) return true; // local-use NAT64 64:ff9b:1::/48 (reaches a local translator)
  if (h0 === 0x100 && !h1 && !h2 && !h3) return true; // discard-only 100::/64
  // IETF protocol assignments 2001::/23: Teredo (2001::/32, tunnels to an embedded client), benchmarking, ORCHID, …
  if (h0 === 0x2001 && h1 < 0x200) return true;
  if (h0 === 0x2001 && h1 === 0xdb8) return true; // documentation 2001:db8::/32
  if (h0 === 0x2002) return nonPublicV4(v4From(h1, h2)); // 6to4 2002::/16 (embedded IPv4)
  if ((h0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((h0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((h0 & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated, still routed internally)
  if ((h0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}
