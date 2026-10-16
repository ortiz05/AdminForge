import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { checkBundle, initialScripts, measureInitialLoad } from '../../../tooling/ci/check-bundle.mjs';

// tooling/ci/check-bundle.mjs (CI's initial-load budget) against small synthetic builds: which scripts count, how
// they are measured, and the verdict and exit code on each side of the budget.
const SCRIPT = fileURLToPath(new URL('../../../tooling/ci/check-bundle.mjs', import.meta.url));

const HTML = (head: string) =>
  `<!doctype html><html><head>${head}</head><body><div id="root"></div></body></html>`;

function fakeBuild(files: Record<string, string | Buffer>, head: string) {
  const dist = mkdtempSync(path.join(tmpdir(), 'af-bundle-'));
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(path.join(dist, 'index.html'), HTML(head));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dist, name), body);
  return { dist, cleanup: () => rmSync(dist, { recursive: true, force: true }) };
}

const gz = (body: string | Buffer) => gzipSync(body, { level: 9 }).length;

describe('check-bundle', () => {
  it('counts the entry module, modulepreloads and classic scripts — once each, not lazy chunks or styles', () => {
    const html = HTML(
      [
        '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
        '<link rel="modulepreload" crossorigin href="/assets/vendor-def.js">',
        '<link rel="modulepreload" href="/assets/index-abc.js">',
        '<script src="/legacy.js"></script>',
        '<link rel="stylesheet" href="/assets/index.css">',
        '<link rel="prefetch" href="/assets/lazy-page.js">',
      ].join(''),
    );
    expect(initialScripts(html)).toEqual(['/assets/index-abc.js', '/legacy.js', '/assets/vendor-def.js']);
  });

  it('measures the gzip size of each initial script, largest first', () => {
    const small = 'export const a = 1;\n';
    const large = 'export const b = "' + 'x'.repeat(5000) + randomBytes(512).toString('hex') + '";\n';
    const b = fakeBuild(
      { 'assets/entry.js': small, 'assets/vendor.js': large, 'assets/lazy.js': large },
      '<script type="module" src="/assets/entry.js"></script><link rel="modulepreload" href="/assets/vendor.js">',
    );
    try {
      const m = measureInitialLoad(b.dist);
      expect(m.files).toEqual([
        { file: '/assets/vendor.js', gzipBytes: gz(large) },
        { file: '/assets/entry.js', gzipBytes: gz(small) },
      ]);
      expect(m.totalBytes).toBe(gz(large) + gz(small));
    } finally {
      b.cleanup();
    }
  });

  it('passes within the budget and fails over it', () => {
    // Random bytes don't compress: about 3 KB gzip.
    const b = fakeBuild(
      { 'assets/entry.js': randomBytes(3 * 1024) },
      '<script type="module" src="/assets/entry.js"></script>',
    );
    try {
      const within = checkBundle(b.dist, 4);
      expect(within.ok).toBe(true);
      expect(within.err).toEqual([]);
      expect(within.out.at(-1)).toMatch(/^✓ Initial JS 3\.\d KB gzip of 4 KB \(\d+% of budget, 1 files\)\.$/);
      const over = checkBundle(b.dist, 2);
      expect(over.ok).toBe(false);
      expect(over.err.join('\n')).toMatch(/^✗ Initial JS is 3\.\d KB gzip, over the 2 KB budget\. Lazy-load/);
    } finally {
      b.cleanup();
    }
  });

  it('fails when index.html names no scripts (no build)', () => {
    const b = fakeBuild({}, '<title>empty</title>');
    try {
      const r = checkBundle(b.dist, 250);
      expect(r.ok).toBe(false);
      expect(r.err.join('\n')).toContain('run pnpm build first');
    } finally {
      b.cleanup();
    }
  });

  it('exits 0 or 1 from the command line, with the dist directory and budget as arguments', () => {
    const b = fakeBuild(
      { 'assets/entry.js': randomBytes(3 * 1024) },
      '<script type="module" src="/assets/entry.js"></script>',
    );
    try {
      const ok = spawnSync(process.execPath, [SCRIPT, b.dist, '4'], { encoding: 'utf8' });
      expect([ok.status, ok.stdout]).toEqual([0, expect.stringContaining('✓ Initial JS')]);
      const over = spawnSync(process.execPath, [SCRIPT, b.dist, '1'], { encoding: 'utf8' });
      expect([over.status, over.stderr]).toEqual([1, expect.stringContaining('over the 1 KB budget')]);
    } finally {
      b.cleanup();
    }
  });
});
