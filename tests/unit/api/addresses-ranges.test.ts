import { isNonPublicAddress } from '@adminforge/api/src/probes/addresses';

// The SSRF address classifier shared by HTTP probes and public news feeds: every non-public range, with a public
// neighbour next to it so an over-broad rule fails too.
describe('isNonPublicAddress', () => {
  it.each([
    // IPv4
    ['0.0.0.0', true],
    ['10.0.0.1', true],
    ['100.64.0.1', true],
    ['100.128.0.1', false],
    ['127.0.0.1', true],
    ['169.254.169.254', true],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['192.0.0.8', true],
    ['192.0.2.10', true], // TEST-NET-1
    ['192.0.3.10', false],
    ['192.88.99.1', true], // 6to4 relay anycast
    ['192.88.98.1', false],
    ['198.18.0.1', true], // benchmarking 198.18.0.0/15
    ['198.19.255.254', true],
    ['198.20.0.1', false],
    ['198.51.100.7', true], // TEST-NET-2
    ['198.51.101.7', false],
    ['203.0.113.9', true], // TEST-NET-3
    ['203.0.114.9', false],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
    ['20.112.52.29', false],
    ['8.8.8.8', false],
  ])('%s → non-public %s', (ip, expected) => {
    expect(isNonPublicAddress(ip)).toBe(expected);
  });

  it.each([
    ['::', true],
    ['::1', true],
    // IPv4-mapped, dotted and hex
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['::ffff:a9fe:a9fe', true], // 169.254.169.254
    ['::ffff:8.8.8.8', false],
    ['::ffff:808:808', false],
    // SIIT-translated ::ffff:0:a.b.c.d
    ['::ffff:0:127.0.0.1', true],
    ['::ffff:0:7f00:1', true],
    ['::ffff:0:10.1.2.3', true],
    ['::ffff:0:8.8.8.8', false],
    // deprecated IPv4-compatible
    ['::10.0.0.1', true],
    // NAT64 well-known prefix (embedded IPv4) and local-use prefix
    ['64:ff9b::7f00:1', true],
    ['64:ff9b::10.0.0.1', true],
    ['64:ff9b::808:808', false],
    ['64:ff9b:1::808:808', true],
    ['64:ff9b:2::808:808', false],
    // discard-only
    ['100::1', true],
    ['100:0:0:1::1', false],
    // IETF protocol assignments 2001::/23 (Teredo 2001::/32, benchmarking 2001:2::/48, ORCHID …)
    ['2001::1', true],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', true], // Teredo
    ['2001:2::1', true],
    ['2001:1ff::1', true],
    ['2001:200::1', false],
    // documentation
    ['2001:db8::1', true],
    ['2001:db9::1', false],
    // 6to4 (embedded IPv4)
    ['2002:7f00:1::1', true],
    ['2002:c0a8:101::1', true], // 192.168.1.1
    ['2002:808:808::1', false],
    // unique-local, link-local, site-local, multicast
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['fe80::1', true],
    ['fe80::1%eth0', true],
    ['febf::1', true],
    ['fec0::1', true],
    ['feff::1', true],
    ['ff02::1', true],
    // global unicast
    ['2603:1030:20e:3::23c', false],
    ['2620:1ec:bdf::40', false],
    ['[2620:1ec:bdf::40]', false],
  ])('%s → non-public %s', (ip, expected) => {
    expect(isNonPublicAddress(ip)).toBe(expected);
  });

  it('treats anything unparseable as non-public', () => {
    for (const junk of ['', 'example.com', '1.2.3', '256.1.1.1', '::g', '1::2::3', 'fe80::1::'])
      expect(isNonPublicAddress(junk)).toBe(true);
  });
});
