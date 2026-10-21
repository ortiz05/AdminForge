import { parseAllDocuments } from 'yaml';
import { committableFiles, readText } from '../lib/repo';

// The Kubernetes deployment keeps the shape SQLite needs (ADR-016/017): one pod owns the database file — a single
// replica, replaced with Recreate, on a volume only one pod can mount — and the pod is locked down (non-root, no
// privilege escalation, no capabilities, read-only root file system, no service-account token, the runner on the
// pod's loopback, the metadata service unreachable). Nothing installation-specific is in the base.
const DIR = 'portal/deploy/kubernetes/';
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const docs = (file: string): Doc[] =>
  parseAllDocuments(readText(file) ?? '')
    .map((d) => d.toJS() as Doc)
    .filter(Boolean);
const manifests = committableFiles().filter((f) => f.startsWith(DIR) && f.endsWith('.yaml'));
const all = manifests.flatMap((f) => docs(f).map((d) => ({ file: f, doc: d })));
const kind = (k: string, under = `${DIR}base/`) =>
  all.filter((m) => m.file.startsWith(under) && m.doc.kind === k).map((m) => m.doc);
/** The one manifest of a kind (the test fails loudly when it is missing). */
const one = (k: string, under?: string): Doc => {
  const [d] = kind(k, under);
  if (!d) throw new Error(`no ${k} under ${under ?? `${DIR}base/`}`);
  return d;
};

describe('Kubernetes manifests', () => {
  const deployment = one('Deployment');
  const pod = deployment?.spec?.template?.spec ?? {};
  const container = (name: string) => (pod.containers ?? []).find((c: Doc) => c.name === name) ?? {};

  it('one pod owns the database: a single replica, replaced with Recreate, on a volume one pod can mount', () => {
    expect(deployment.spec.replicas).toBe(1);
    expect(deployment.spec.strategy).toEqual({ type: 'Recreate' });
    const pvc = one('PersistentVolumeClaim');
    expect(pvc.spec.accessModes).toEqual(['ReadWriteOncePod']);
    expect(pvc.metadata.name).toBe('adminforge-data');
    expect(pod.volumes.find((v: Doc) => v.name === 'data').persistentVolumeClaim.claimName).toBe(
      'adminforge-data',
    );
    expect(container('api').volumeMounts.find((m: Doc) => m.name === 'data').mountPath).toBe(
      '/var/lib/adminforge',
    );
    // The runner never sees the database.
    expect((container('runner').volumeMounts ?? []).map((m: Doc) => m.name)).not.toContain('data');
  });

  it('the database file is on the volume, and the pod layout wins over a copied env file', () => {
    const k = one('Kustomization');
    const literals: string[] = k.configMapGenerator.find((g: Doc) => g.name === 'adminforge-config').literals;
    expect(literals).toContain('DATABASE_PATH=/var/lib/adminforge/adminforge.db');
    expect(literals).toContain('ADMINFORGE_ARTIFACTS_DIR=/var/lib/adminforge/artifacts');
    expect(literals).toContain('NODE_ENV=production');
    expect(container('api').envFrom.map((e: Doc) => Object.keys(e)[0])).toEqual([
      'secretRef',
      'configMapRef',
    ]);
  });

  it('every container is locked down, and the pod has no Kubernetes API token', () => {
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(one('ServiceAccount').automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    for (const c of pod.containers) {
      expect(c.securityContext, c.name).toMatchObject({
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      });
      expect(Number.isInteger(c.securityContext.runAsUser) && c.securityContext.runAsUser > 0, c.name).toBe(
        true,
      );
      expect(c.securityContext.privileged).toBeUndefined();
    }
  });

  it('the runner listens on the pod loopback and gets only its key', () => {
    const env: Doc[] = container('runner').env;
    expect(env.find((e) => e.name === 'RUNNER_HOST')?.value).toBe('127.0.0.1');
    expect(env.find((e) => e.name === 'RUNNER_SHARED_KEY')?.valueFrom.secretKeyRef).toEqual({
      name: 'adminforge-env',
      key: 'RUNNER_SHARED_KEY',
    });
    expect(container('runner').envFrom).toBeUndefined();
  });

  it('probes use the health endpoints; the network policy keeps the metadata service out of reach', () => {
    expect(container('api').readinessProbe.httpGet.path).toBe('/readyz');
    expect(container('api').livenessProbe.httpGet.path).toBe('/healthz');
    const np = one('NetworkPolicy');
    expect(np.spec.policyTypes).toEqual(['Ingress', 'Egress']);
    const blocks = np.spec.egress.flatMap((e: Doc) =>
      (e.to ?? []).map((t: Doc) => t.ipBlock).filter(Boolean),
    );
    expect(blocks.every((b: Doc) => b.except?.includes('169.254.0.0/16'))).toBe(true);
    // DNS only to the cluster's resolver.
    const dns = np.spec.egress.find((e: Doc) => e.ports?.some((p: Doc) => p.port === 53));
    expect(dns?.to?.[0]?.podSelector?.matchLabels).toEqual({ 'k8s-app': 'kube-dns' });
  });

  it('the base names no installation: no registry, tag, host name or namespace', () => {
    const images = kind('Deployment').flatMap((d) =>
      d.spec.template.spec.containers.map((c: Doc) => c.image),
    );
    expect(images.sort()).toEqual(['adminforge', 'adminforge-runner']);
    for (const m of all.filter((x) => x.file.startsWith(`${DIR}base/`)))
      expect(m.doc.metadata?.namespace, m.file).toBeUndefined();
    expect(kind('Ingress')).toEqual([]);
  });

  it('the example overlay pins its images and uses example names only', () => {
    const k = one('Kustomization', `${DIR}overlays/example/`);
    for (const i of k.images) {
      expect(i.newName).toMatch(/^registry\.example\.com\//);
      expect(i.newTag ?? i.digest).toBeTruthy();
      expect(i.newTag).not.toBe('latest');
    }
    const ingress = one('Ingress', `${DIR}overlays/example/`);
    expect(ingress.spec.rules.map((r: Doc) => r.host)).toEqual(['adminforge.example.com']);
    // Server-Sent Events (/api/events, run streams) must not be buffered by the ingress controller.
    expect(ingress.metadata.annotations['nginx.ingress.kubernetes.io/proxy-buffering']).toBe('off');
  });
});
