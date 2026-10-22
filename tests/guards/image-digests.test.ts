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

/**
 * Every image the build pulls, with the line that names it: FROM, COPY --from= and RUN --mount=…,from= — skipping
 * references to an earlier stage of the same file (by name or number).
 */
function images(text: string): { line: string; image: string }[] {
  const stages = new Set<string>();
  const out: { line: string; image: string }[] = [];
  const external = (ref: string) => !stages.has(ref.toLowerCase()) && !/^\d+$/.test(ref);
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    if (from) {
      if (external(from[1]!)) out.push({ line, image: from[1]! });
      if (from[2]) stages.add(from[2].toLowerCase());
      continue;
    }
    const copy = /^COPY\b.*?--from=(\S+)/i.exec(line);
    if (copy && external(copy[1]!)) out.push({ line, image: copy[1]! });
    for (const mount of line.matchAll(/--mount=\S*?\bfrom=([^,\s]+)/gi))
      if (external(mount[1]!)) out.push({ line, image: mount[1]! });
  }
  return out;
}

/** The parser directives at the top of the file (`# syntax=`, `# check=`, `# escape=`), until the first other line. */
function directives(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^#\s*([a-z]+)\s*=\s*(\S+)\s*$/i.exec(line);
    if (!m) break;
    out[m[1]!.toLowerCase()] = m[2]!;
  }
  return out;
}

describe('base images are pinned by digest', () => {
  it('finds the Dockerfiles (the app image and the runner)', () => {
    expect(dockerfiles).toEqual(
      expect.arrayContaining(['portal/deploy/kubernetes/Dockerfile', 'portal/apps/runner/Dockerfile']),
    );
  });

  it.each(dockerfiles)('%s: every image it pulls is named image:tag@sha256:digest', (file) => {
    const pulled = images(readText(file) ?? '');
    expect(pulled.length).toBeGreaterThan(0);
    for (const { line, image } of pulled) {
      expect(image, `${line} — name the image literally (Dependabot can't follow an ARG)`).not.toMatch(/\$/);
      expect(image, line).toMatch(DIGEST);
    }
    // The same image at the same digest in every stage: one bump moves them all.
    const byName = new Map<string, Set<string>>();
    for (const { image } of pulled) {
      const [name] = image.split('@');
      byName.set(name!, (byName.get(name!) ?? new Set()).add(image));
    }
    for (const [name, refs] of byName) expect([...refs], name).toHaveLength(1);
  });

  it.each(dockerfiles)('%s: the # syntax= frontend is pinned too', (file) => {
    const syntax = directives(readText(file) ?? '').syntax;
    if (syntax) expect(syntax).toMatch(DIGEST);
  });

  it('reads every form of image reference (the guard checks itself)', () => {
    const text = [
      '# check=error=true',
      '# syntax=docker/dockerfile:1.7',
      'FROM node:26 AS build',
      'FROM build AS again',
      'COPY --from=build /a /b',
      'COPY --from=0 /a /b',
      'COPY --link --from=alpine:3 /x /y',
      'RUN --mount=type=cache,target=/c --mount=type=bind,from=busybox:1,source=/,target=/b true',
    ].join('\n');
    expect(images(text).map((i) => i.image)).toEqual(['node:26', 'alpine:3', 'busybox:1']);
    expect(directives(text).syntax).toBe('docker/dockerfile:1.7');
  });
});
