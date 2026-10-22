import path from 'node:path';
import { committableFiles, readText } from '../../lib/repo';

// The package manager sits above the lockfile: it is what enforces `--frozen-lockfile` and the seven-day release-age
// floor (S-04), and neither comes through that floor itself. So both are pinned by hash in git. pnpm: the exact
// version with its sha512 in `packageManager` (Corepack refuses a download that doesn't match). Corepack, which Node 25
// and later no longer bundle: an exact version whose registry tarball an image checks against a recorded sha512
// before installing it, without install scripts; the setup guide installs the same version. A bump is a reviewed
// commit of version and hash, once the version is seven days old.
const pkg = JSON.parse(readText('package.json') ?? '{}') as { packageManager?: string };
const dockerfiles = committableFiles().filter((f) =>
  /^(Dockerfile|.+\.Dockerfile|Dockerfile\..+)$/.test(path.basename(f)),
);
const GLOBAL_INSTALL = /\bnpm\s+(?:install|i)\b[^\n]*?(?:--global|-g)\b/;
const DOCS = ['README.md', 'docs/onboarding/01-setup.md', 'docs/onboarding/checklists.md'];

/** The Dockerfile's RUN instructions, continuation lines joined. */
function runs(text: string): string[] {
  return text
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^RUN\s/i.test(l));
}

const appImage = readText('portal/deploy/kubernetes/Dockerfile') ?? '';
const corepackInImage = /corepack@(\d+\.\d+\.\d+)/.exec(runs(appImage).join('\n'))?.[1];

describe('package manager pins', () => {
  it('packageManager names an exact pnpm with its sha512', () => {
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
  });

  it('the app image installs an exact Corepack', () => {
    expect(corepackInImage).toBeDefined();
  });

  it.each(dockerfiles)(
    '%s: a global npm install is one exact version, hash-checked, without install scripts',
    (file) => {
      for (const run of runs(readText(file) ?? '').filter((r) => GLOBAL_INSTALL.test(r))) {
        expect(run, run).toContain('--ignore-scripts');
        // `npm pack name@x.y.z`, then `sha512sum -c` on the tarball, then the install from that tarball.
        const pack = /\bnpm\s+pack\b[^&|;]*?\s((?:@[\w.-]+\/)?[\w.-]+)@(\d+\.\d+\.\d+)\b/.exec(run);
        expect(pack, `${run} — npm pack <name>@<x.y.z> first`).not.toBeNull();
        const tarball = `${pack![1]!.replace(/^@/, '').replace('/', '-')}-${pack![2]}.tgz`;
        expect(run, run).toMatch(
          new RegExp(`[0-9a-f]{128}\\s+${tarball.replace(/\./g, '\\.')}[\\s\\S]*sha512sum -c`),
        );
        expect(run, run).toMatch(
          new RegExp(`npm\\s+(?:install|i)\\b[^&|;]*\\./${tarball.replace(/\./g, '\\.')}`),
        );
      }
    },
  );

  it.each(DOCS)('%s installs the Corepack the app image installs, without install scripts', (doc) => {
    const installs = [...(readText(doc) ?? '').matchAll(/npm install --global[^`\n]*corepack[^`\n]*/g)].map(
      (m) => m[0],
    );
    expect(installs.length, doc).toBeGreaterThan(0);
    for (const line of installs) {
      expect(line).toContain('--ignore-scripts');
      expect(line).toContain(`corepack@${corepackInImage}`);
    }
  });
});
