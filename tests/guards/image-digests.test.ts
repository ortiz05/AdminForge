import path from 'node:path';
import { committableFiles, readText } from '../lib/repo';

// S-37: every image a build starts from is pinned by digest, so a rebuild of the same commit gets the same bases — a
// moved or replaced tag can't slip new code into AdminForge's images. Each reference keeps its tag next to the digest
// (`name:tag@sha256:…`): people can read which version it is, and Dependabot's docker ecosystem bumps tag and digest
// together (it can't follow `FROM ${ARG}`, so FROM lines name the image literally). The BuildKit frontend that the
// `# syntax=` line pulls is an image too.
const DIGEST = /^[^\s@:]+(?::[\w.-]+)@sha256:[0-9a-f]{64}$/;
const dockerfiles = committableFiles().filter(
  (f) =>
    /^(Dockerfile|.+\.Dockerfile|Dockerfile\..+)$/.test(path.basename(f)) && !f.endsWith('.dockerignore'),
);

/** FROM lines with their image, skipping references to an earlier stage of the same file. */
function froms(text: string): { line: string; image: string }[] {
  const stages = new Set<string>();
  const out: { line: string; image: string }[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    if (!m) continue;
    const image = m[1]!;
    if (!stages.has(image.toLowerCase())) out.push({ line, image });
    if (m[2]) stages.add(m[2].toLowerCase());
  }
  return out;
}

describe('base images are pinned by digest', () => {
  it('finds the Dockerfiles (the app image and the runner)', () => {
    expect(dockerfiles).toEqual(
      expect.arrayContaining(['portal/deploy/kubernetes/Dockerfile', 'portal/apps/runner/Dockerfile']),
    );
  });

  it.each(dockerfiles)('%s: every FROM names image:tag@sha256:digest', (file) => {
    const text = readText(file) ?? '';
    const images = froms(text);
    expect(images.length).toBeGreaterThan(0);
    for (const { line, image } of images) {
      expect(image, `${line} — name the image literally (Dependabot can't follow an ARG)`).not.toMatch(/\$/);
      expect(image, line).toMatch(DIGEST);
    }
    // The same image at the same digest in every stage: one bump moves them all.
    const byName = new Map<string, Set<string>>();
    for (const { image } of images) {
      const [name] = image.split('@');
      byName.set(name!, (byName.get(name!) ?? new Set()).add(image));
    }
    for (const [name, refs] of byName) expect([...refs], name).toHaveLength(1);
  });

  it.each(dockerfiles)('%s: the # syntax= frontend is pinned too', (file) => {
    const first = (readText(file) ?? '').split('\n')[0] ?? '';
    const m = /^#\s*syntax\s*=\s*(\S+)/.exec(first);
    if (m) expect(m[1], first).toMatch(DIGEST);
  });
});
