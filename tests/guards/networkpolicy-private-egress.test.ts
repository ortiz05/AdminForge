import { parseAllDocuments } from 'yaml';
import { committableFiles, readText } from '../lib/repo';

// S-40: the pod's egress on 443 reaches public addresses only. AdminForge talks to Microsoft's public endpoints; the
// base NetworkPolicy refuses every private range (RFC 1918, carrier-grade NAT, link-local with the cloud metadata
// service, Azure's WireServer), so HTTP probes, PowerShell in write mode or a compromised dependency can't reach other
// services in the cluster or the network around it. An installation names the private addresses it needs (its
// Ingress, a Private Link endpoint) in a policy of its own — the example overlay shows how — never by loosening the
// base.
const DIR = 'portal/deploy/kubernetes/';
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const PRIVATE = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '168.63.129.16/32',
];

const manifests = committableFiles().filter((f) => f.startsWith(DIR) && f.endsWith('.yaml'));
const all = manifests.flatMap((file) =>
  parseAllDocuments(readText(file) ?? '')
    .map((d) => d.toJS() as Doc)
    .filter(Boolean)
    .map((doc) => ({ file, doc })),
);
const policies = (under: string) =>
  all.filter((m) => m.file.startsWith(`${DIR}${under}`) && m.doc.kind === 'NetworkPolicy').map((m) => m.doc);

/** An IPv4 CIDR as [network, prefix length]. */
function cidr(text: string): [number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(text);
  if (!m) throw new Error(`not an IPv4 CIDR: ${text}`);
  const ip = m.slice(1, 5).reduce((n, o) => n * 256 + Number(o), 0);
  return [ip, Number(m[5])];
}
const within = (inner: string, outer: string) => {
  const [a, al] = cidr(inner);
  const [b, bl] = cidr(outer);
  const size = 2 ** (32 - bl);
  return al >= bl && Math.floor(a / size) === Math.floor(b / size);
};

describe('NetworkPolicy: private egress is refused', () => {
  const base = policies('base/').find((p) => p.metadata.name === 'adminforge');

  it('the base policy allows 443 to public addresses only', () => {
    expect(base, 'base/networkpolicy.yaml').toBeDefined();
    const https = base!.spec.egress.filter((e: Doc) => e.ports?.some((p: Doc) => p.port === 443));
    expect(https.length).toBeGreaterThan(0);
    for (const rule of https) {
      expect(rule.ports).toEqual([{ port: 443, protocol: 'TCP' }]);
      for (const to of rule.to) {
        expect(to.ipBlock?.cidr).toBe('0.0.0.0/0');
        for (const range of PRIVATE) expect(to.ipBlock.except, range).toContain(range);
      }
    }
  });

  it('no base egress rule is open to everything or on another port', () => {
    for (const rule of base!.spec.egress) {
      // A rule without `to` allows every destination; without `ports`, every port.
      expect(rule.to?.length, JSON.stringify(rule)).toBeGreaterThan(0);
      expect(rule.ports?.length, JSON.stringify(rule)).toBeGreaterThan(0);
      for (const p of rule.ports) expect([53, 443]).toContain(p.port);
      if (rule.ports.some((p: Doc) => p.port === 53))
        // DNS only to the cluster's resolver: an open port 53 is a way out for data.
        expect(rule.to.every((t: Doc) => t.podSelector?.matchLabels?.['k8s-app'] === 'kube-dns')).toBe(true);
    }
  });

  it('the loader pod gets no network at all (kubectl cp and exec need none)', () => {
    const loader = all.find((m) => m.file === `${DIR}tools/loader-pod.yaml`)?.doc;
    const label = loader?.metadata?.labels?.['app.kubernetes.io/name'];
    expect(label).toBe('adminforge-loader');
    const policy = policies('base/').find(
      (p) => p.spec.podSelector?.matchLabels?.['app.kubernetes.io/name'] === label,
    );
    expect(policy?.spec.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(policy?.spec.ingress ?? []).toEqual([]);
    expect(policy?.spec.egress ?? []).toEqual([]);
  });

  it("the example overlay never loosens the base: it doesn't patch the base policy's egress", () => {
    const k = all.find((m) => m.file === `${DIR}overlays/example/kustomization.yaml`)?.doc;
    for (const p of k?.patches ?? []) {
      if (p.target?.kind !== 'NetworkPolicy') continue;
      expect(String(p.patch)).not.toMatch(/\/spec\/egress/);
    }
  });

  it('the example names its private exceptions narrowly, in a policy of its own', () => {
    const own = policies('overlays/example/');
    expect(own.map((p) => p.metadata.name)).toContain('adminforge-private-egress');
    for (const policy of own) {
      expect(policy.spec.policyTypes).toEqual(['Egress']);
      expect(policy.spec.podSelector.matchLabels).toEqual({ 'app.kubernetes.io/name': 'adminforge' });
      for (const rule of policy.spec.egress) {
        expect(rule.ports).toEqual([{ port: 443, protocol: 'TCP' }]);
        expect(rule.to?.length).toBeGreaterThan(0);
        for (const to of rule.to) {
          if (to.ipBlock) {
            // A private address or a small subnet (a private endpoint's), never a whole private range.
            expect(
              PRIVATE.some((r) => within(to.ipBlock.cidr, r)),
              to.ipBlock.cidr,
            ).toBe(true);
            expect(cidr(to.ipBlock.cidr)[1], to.ipBlock.cidr).toBeGreaterThanOrEqual(24);
          } else {
            // Or named pods: a namespace and the pods in it.
            expect(to.namespaceSelector?.matchLabels, JSON.stringify(to)).toBeDefined();
            expect(to.podSelector?.matchLabels, JSON.stringify(to)).toBeDefined();
          }
        }
      }
    }
  });
});
