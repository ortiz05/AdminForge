import { parseAllDocuments } from 'yaml';
import { committableFiles, readText } from '../lib/repo';

// Every production-only control — HSTS, the __Host- session cookie, no mock sign-in, https, content from the database,
// the stray-credential refusal — keys off NODE_ENV=production, and portal/apps/api/src/config.ts refuses Entra sign-in
// beyond loopback without it (S-01, D-04). The deployment pins it twice: in the app image, and in the base ConfigMap,
// which the Deployment lists after the Secret so a copied env file's NODE_ENV=development loses. Nothing in the
// deployment may set anything else.
const DIR = 'portal/deploy/kubernetes/';
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** ENV of the image's last stage — what the container starts with. Comment lines dropped, continuations joined. */
function finalStageEnv(dockerfile: string): Record<string, string> {
  const instructions = dockerfile
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
    .replace(/\\\r?\n/g, ' ')
    .split('\n')
    .map((l) => l.trim());
  let env: Record<string, string> = {};
  for (const line of instructions) {
    if (/^FROM\s/i.test(line)) env = {};
    const m = /^ENV\s+(.+)$/i.exec(line);
    if (!m) continue;
    const pairs = m[1]!.match(/[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)/g);
    if (pairs)
      for (const pair of pairs) {
        const i = pair.indexOf('=');
        env[pair.slice(0, i)] = pair.slice(i + 1).replace(/^["']|["']$/g, '');
      }
    else {
      const [key, ...value] = m[1]!.split(/\s+/); // the legacy `ENV KEY value` form
      env[key!] = value.join(' ');
    }
  }
  return env;
}

const files = committableFiles().filter((f) => f.startsWith(DIR));
const yamlDocs = files
  .filter((f) => /\.ya?ml$/.test(f))
  .flatMap((f) =>
    parseAllDocuments(readText(f) ?? '')
      .map((d) => d.toJS() as Doc)
      .filter(Boolean)
      .map((doc) => ({ file: f, doc })),
  );

/** `env:` entries named NODE_ENV anywhere in a manifest (container env, patches). */
function envEntries(node: unknown, out: Doc[] = []): Doc[] {
  if (Array.isArray(node)) for (const n of node) envEntries(n, out);
  else if (node && typeof node === 'object') {
    const o = node as Doc;
    if (o.name === 'NODE_ENV' && ('value' in o || 'valueFrom' in o)) out.push(o);
    for (const v of Object.values(o)) envEntries(v, out);
  }
  return out;
}

describe('the deployment runs with NODE_ENV=production', () => {
  it('the app image sets it in the stage the container starts from', () => {
    const dockerfile = readText(`${DIR}Dockerfile`);
    expect(dockerfile, `${DIR}Dockerfile`).toBeDefined();
    expect(finalStageEnv(dockerfile!).NODE_ENV).toBe('production');
  });

  it('the base ConfigMap sets it, and the api container reads the ConfigMap after the Secret', () => {
    const kustomization = yamlDocs.find((d) => d.file === `${DIR}base/kustomization.yaml`)?.doc;
    const generator = (kustomization?.configMapGenerator ?? []).find(
      (g: Doc) => g.name === 'adminforge-config',
    );
    expect(generator?.literals).toContain('NODE_ENV=production');
    const deployment = yamlDocs.find(
      (d) => d.file.startsWith(`${DIR}base/`) && d.doc.kind === 'Deployment',
    )?.doc;
    const api = (deployment?.spec?.template?.spec?.containers ?? []).find((c: Doc) => c.name === 'api');
    const sources: string[] = (api?.envFrom ?? []).map((e: Doc) => (e.secretRef ? 'secret' : 'configMap'));
    expect(sources.lastIndexOf('configMap')).toBeGreaterThan(sources.lastIndexOf('secret'));
  });

  it('no Dockerfile, manifest, overlay or script in the deployment sets another value', () => {
    const others: string[] = [];
    for (const f of files) {
      const text = readText(f) ?? '';
      for (const m of text.matchAll(/\bNODE_ENV\s*=\s*["']?([A-Za-z]*)/g))
        if (m[1] !== 'production') others.push(`${f}: NODE_ENV=${m[1]}`);
    }
    for (const { file, doc } of yamlDocs)
      for (const e of envEntries(doc))
        if (e.value !== 'production')
          others.push(`${file}: env NODE_ENV=${JSON.stringify(e.value ?? e.valueFrom)}`);
    expect(others).toEqual([]);
  });
});
