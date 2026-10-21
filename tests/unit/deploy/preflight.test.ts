import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoRoot } from '../../lib/repo';

// portal/deploy/kubernetes/preflight.sh: the read-only cluster check for the people preparing a cluster. A stub
// `kubectl` on PATH answers from a scenario and logs every call, so these tests see exactly what the script asks the
// cluster — reads, one server-side dry run, never a change and never a Secret's data.
const SCRIPT = path.join(repoRoot, 'portal/deploy/kubernetes/preflight.sh');

interface Rule {
  /** Regular expression over the kubectl arguments joined by spaces (after the optional --context pair). */
  match: string;
  stdout?: string;
  stderr?: string;
  code?: number;
}

const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(process.env.KUBECTL_STUB, 'utf8'));
let stdin = '';
if (args.includes('-f')) stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.KUBECTL_LOG, JSON.stringify({ args, stdin }) + '\\n');
const rest = args[0] === '--context' ? args.slice(2) : args;
const line = rest.join(' ');
const rule = scenario.find((r) => new RegExp(r.match).test(line));
if (!rule) {
  process.stderr.write('stub: no answer for: ' + line + '\\n');
  process.exit(99);
}
if (rule.stdout) process.stdout.write(rule.stdout);
if (rule.stderr) process.stderr.write(rule.stderr);
process.exit(rule.code ?? 0);
`;

const VERSION = (minor: string) =>
  JSON.stringify({ major: '1', minor, gitVersion: `v1.${minor.replace('+', '')}.4` }, null, 2);
const NOT_FOUND = (what: string) => ({
  stderr: `Error from server (NotFound): ${what} not found\n`,
  code: 1,
});
const NODES_OK =
  'node-a\tamd64\t3860m\t14261284Ki\t119703055367\t\n' + 'node-b\tamd64\t3860m\t14261284Ki\t119703055367\t\n';

/** A cluster that has everything: the answers each later test changes one at a time. */
function goodCluster(): Record<string, Rule> {
  return {
    context: { match: '^config current-context$', stdout: 'example-cluster\n' },
    version: { match: '^get --raw /version$', stdout: VERSION('31') },
    namespace: {
      match: '^get namespace adminforge -o jsonpath=',
      stdout: 'restricted',
    },
    classes: {
      match: '^get storageclass -o jsonpath=',
      stdout: 'managed-csi\ttrue\nazurefile-csi\t\n',
    },
    class: {
      match: '^get storageclass managed-csi -o jsonpath=',
      stdout: 'disk.csi.azure.com\tWaitForFirstConsumer\ttrue\t{"skuname":"StandardSSD_LRS"}',
    },
    csidriver: { match: '^get csidriver disk.csi.azure.com -o jsonpath=', stdout: 'File' },
    dryRun: {
      match: '^-n adminforge create --dry-run=server -o name -f -$',
      stdout: 'persistentvolumeclaim/adminforge-preflight\n',
    },
    apis: {
      match: '^api-resources --api-group=networking.k8s.io -o name$',
      stdout:
        'ingressclasses.networking.k8s.io\ningresses.networking.k8s.io\nnetworkpolicies.networking.k8s.io\n',
    },
    daemonsets: {
      match: '^get daemonsets --all-namespaces -o jsonpath=',
      stdout: 'kube-proxy\ncilium\ncsi-azuredisk-node\n',
    },
    dns: {
      match: '^-n kube-system get pods -l k8s-app=kube-dns -o name$',
      stdout: 'pod/coredns-1\npod/coredns-2\n',
    },
    nodes: { match: '^get nodes -o jsonpath=', stdout: NODES_OK },
    ingressClasses: { match: '^get ingressclass -o jsonpath=', stdout: 'nginx\tk8s.io/ingress-nginx\n' },
    pullSecret: {
      match: '^-n adminforge get secret registry-pull -o jsonpath=\\{\\.type\\}$',
      stdout: 'kubernetes.io/dockerconfigjson',
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'af-preflight-'));
  writeFileSync(path.join(dir, 'kubectl'), STUB);
  chmodSync(path.join(dir, 'kubectl'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(cluster: Record<string, Rule>, args: string[] = []) {
  writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(Object.values(cluster)));
  rmSync(path.join(dir, 'calls.log'), { force: true });
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      HOME: dir,
      KUBECTL_STUB: path.join(dir, 'scenario.json'),
      KUBECTL_LOG: path.join(dir, 'calls.log'),
    },
  });
  let calls: { args: string[]; stdin: string }[] = [];
  try {
    calls = readFileSync(path.join(dir, 'calls.log'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    // no call made
  }
  const lines = res.stdout.split('\n').filter(Boolean);
  return { code: res.status, out: res.stdout, err: res.stderr, lines, calls };
}
const line = (lines: string[], mark: '✓' | '✗' | '⚠', text: RegExp) =>
  lines.find((l) => l.startsWith(mark) && text.test(l));

describe('preflight.sh', () => {
  it('passes on a cluster that has everything, with one line per check', () => {
    const r = run(goodCluster(), ['--pull-secret', 'registry-pull']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.lines.filter((l) => l.startsWith('✗'))).toEqual([]);
    for (const text of [
      /Kubernetes 1\.31/,
      /namespace adminforge enforces the restricted Pod Security Standard/i,
      /storage class managed-csi.*disk\.csi\.azure\.com/,
      /fsGroup/,
      /ReadWriteOncePod/,
      /NetworkPolicy API/,
      /policy engine.*cilium/,
      /kube-dns/,
      /amd64/,
      /IngressClass/,
      /registry-pull/,
    ])
      expect(line(r.lines, '✓', text), String(text)).toBeDefined();
    expect(r.out).toMatch(/example-cluster/);
  });

  it('only reads: get, api-resources and one server-side dry run of the database claim', () => {
    const r = run(goodCluster(), ['--pull-secret', 'registry-pull']);
    for (const { args } of r.calls) {
      const verb = args.find((a) => !a.startsWith('-') && a !== 'adminforge' && a !== 'kube-system');
      expect(['get', 'api-resources', 'create', 'config'], args.join(' ')).toContain(verb);
      if (verb === 'create') expect(args).toContain('--dry-run=server');
      if (verb === 'config') expect(args).toEqual(['config', 'current-context']);
    }
    const dry = r.calls.find((c) => c.args.includes('create'));
    expect(dry?.stdin).toMatch(/kind: PersistentVolumeClaim/);
    expect(dry?.stdin).toMatch(/ReadWriteOncePod/);
    expect(dry?.stdin).toMatch(/storageClassName: managed-csi/);
  });

  it('never asks for a Secret in a form that carries its data', () => {
    const r = run(goodCluster(), ['--pull-secret', 'registry-pull']);
    const secretCalls = r.calls.filter((c) => c.args.includes('secret') || c.args.includes('secrets'));
    expect(secretCalls).toHaveLength(1);
    expect(secretCalls[0]!.args.join(' ')).toMatch(/-o jsonpath=\{\.type\}$/);
  });

  it('fails an old cluster, a network file system, an unlabelled namespace and a missing pull secret', () => {
    const c = goodCluster();
    c.version!.stdout = VERSION('28+');
    c.class!.stdout = 'file.csi.azure.com\tImmediate\tfalse\t{"skuName":"Standard_LRS"}';
    c.csidriver = {
      match: '^get csidriver file.csi.azure.com -o jsonpath=',
      stdout: 'ReadWriteOnceWithFSType',
    };
    c.namespace!.stdout = '';
    c.pullSecret = { match: c.pullSecret!.match, ...NOT_FOUND('secrets "registry-pull"') };
    const r = run(c, ['--storage-class', 'managed-csi', '--pull-secret', 'registry-pull']);
    expect(r.code).toBe(1);
    expect(line(r.lines, '✗', /Kubernetes 1\.28.*1\.29/)).toBeDefined();
    expect(line(r.lines, '✗', /file\.csi\.azure\.com.*(network|file)/i)).toBeDefined();
    expect(line(r.lines, '✗', /namespace adminforge.*restricted/i)).toBeDefined();
    expect(line(r.lines, '✗', /registry-pull/)).toBeDefined();
    expect(line(r.lines, '⚠', /Immediate/)).toBeDefined();
    expect(line(r.lines, '⚠', /expansion/i)).toBeDefined();
  });

  it.each([
    ['nfs.csi.k8s.io', '{}'],
    ['smb.csi.k8s.io', '{}'],
    ['efs.csi.aws.com', '{}'],
    ['blob.csi.azure.com', '{"protocol":"fuse2"}'],
    ['cephfs.csi.ceph.com', '{}'],
    ['csi.trident.netapp.io', '{"backendType":"ontap-nas"}'],
  ])('refuses %s %s: SQLite needs local block storage', (provisioner, params) => {
    const c = goodCluster();
    c.class!.stdout = `${provisioner}\tWaitForFirstConsumer\ttrue\t${params}`;
    c.csidriver = {
      match: `^get csidriver ${provisioner.replace(/\./g, '\\.')} -o jsonpath=`,
      stdout: 'File',
    };
    const r = run(c);
    expect(r.code).toBe(1);
    expect(line(r.lines, '✗', new RegExp(provisioner.replace(/\./g, '\\.')))).toBeDefined();
  });

  it('uses the default storage class when none is named, and fails when there is none', () => {
    expect(run(goodCluster()).lines.some((l) => /storage class managed-csi \(the default\)/.test(l))).toBe(
      true,
    );
    const c = goodCluster();
    c.classes!.stdout = 'slow\t\nfast\tfalse\n';
    const r = run(c);
    expect(r.code).toBe(1);
    expect(line(r.lines, '✗', /no default storage class/i)).toBeDefined();
  });

  it('fails a provisioner that is not a CSI driver, or one that never applies fsGroup', () => {
    const c = goodCluster();
    c.csidriver = {
      match: c.csidriver!.match,
      ...NOT_FOUND('csidrivers.storage.k8s.io "disk.csi.azure.com"'),
    };
    expect(line(run(c).lines, '✗', /not a CSI driver/)).toBeDefined();
    c.csidriver = { match: c.csidriver.match, stdout: 'None' };
    const r = run(c);
    expect(r.code).toBe(1);
    expect(line(r.lines, '✗', /fsGroup/)).toBeDefined();
  });

  it('maps a migrated in-tree provisioner to its CSI driver', () => {
    const c = goodCluster();
    c.class!.stdout = 'kubernetes.io/azure-disk\tWaitForFirstConsumer\ttrue\t{}';
    const r = run(c);
    expect(r.code).toBe(0);
    expect(r.calls.some((x) => x.args.join(' ').includes('get csidriver disk.csi.azure.com'))).toBe(true);
  });

  it('reports the server refusing ReadWriteOncePod in its own words', () => {
    const c = goodCluster();
    c.dryRun = {
      match: c.dryRun!.match,
      stderr:
        'The PersistentVolumeClaim "adminforge-preflight" is invalid: spec.accessModes: Unsupported value: "ReadWriteOncePod"\n',
      code: 1,
    };
    const r = run(c);
    expect(r.code).toBe(1);
    expect(line(r.lines, '✗', /ReadWriteOncePod.*Unsupported value/)).toBeDefined();
  });

  it('fails without the NetworkPolicy API or the DNS pods the policy allows; warns without a known policy engine', () => {
    const c = goodCluster();
    c.apis!.stdout = 'ingresses.networking.k8s.io\n';
    c.dns!.stdout = '';
    c.daemonsets!.stdout = 'kube-proxy\nkube-flannel-ds\n';
    const r = run(c);
    expect(r.code).toBe(1);
    expect(line(r.lines, '✗', /NetworkPolicy/)).toBeDefined();
    expect(line(r.lines, '✗', /k8s-app=kube-dns/)).toBeDefined();
    expect(line(r.lines, '⚠', /policy engine/)).toBeDefined();
  });

  it('fails a cluster without amd64 nodes, and warns when no node has room for the limits', () => {
    const c = goodCluster();
    c.nodes!.stdout = 'node-a\tarm64\t4\t16Gi\t100Gi\t\n';
    expect(line(run(c).lines, '✗', /amd64/)).toBeDefined();
    c.nodes!.stdout = 'node-a\tamd64\t2\t3Gi\t100Gi\t\nnode-b\tamd64\t8\t32Gi\t100Gi\ttrue\n';
    const r = run(c);
    expect(r.code).toBe(0);
    expect(line(r.lines, '⚠', /5 GiB/)).toBeDefined();
  });

  it('warns, without failing, when it may not list cluster-wide objects', () => {
    const c = goodCluster();
    const forbidden = {
      stderr: 'Error from server (Forbidden): nodes is forbidden: User "x" cannot list resource "nodes"\n',
      code: 1,
    };
    c.nodes = { match: c.nodes!.match, ...forbidden };
    c.daemonsets = { match: c.daemonsets!.match, ...forbidden };
    const r = run(c);
    expect(r.code).toBe(0);
    expect(line(r.lines, '⚠', /nodes/)).toBeDefined();
  });

  it('stops at once when the cluster cannot be reached', () => {
    const c = goodCluster();
    c.version = {
      match: c.version!.match,
      stderr: 'Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout\n',
      code: 1,
    };
    const r = run(c);
    expect(r.code).toBe(1);
    expect(line(r.lines, '✗', /reach the cluster/)).toBeDefined();
    expect(r.calls.map((x) => x.args.join(' '))).not.toContainEqual(expect.stringMatching(/create/));
  });

  it('passes --context to every call, and refuses unknown options', () => {
    const r = run(goodCluster(), ['--context', 'staging']);
    expect(r.calls.filter((x) => x.args[0] !== '--context' && x.args[0] !== 'config')).toEqual([]);
    const bad = run(goodCluster(), ['--bogus']);
    expect(bad.code).toBe(2);
    expect(bad.calls).toEqual([]);
  });
});
