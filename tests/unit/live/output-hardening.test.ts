import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoRoot } from '@adminforge/config';
import { assertOutsideRepo, liveOutDir, liveOutFile, liveOutRoot } from '../../live/lib/output';

// Live output can show tenant data and screenshots are binary (the tenant-data guard can't read them): the repository
// check must hold through symlinks and for explicit screenshot paths, and an existing output root must stay private.
describe('live output stays out of the repository', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'af-live-hard-'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses AF_LIVE_OUT that is a symlink into the checkout', () => {
    const link = path.join(dir, 'out');
    symlinkSync(path.join(repoRoot, 'tests'), link);
    expect(() => liveOutRoot({ AF_LIVE_OUT: link })).toThrow(/inside the repository/);
    expect(() => liveOutRoot({ AF_LIVE_OUT: path.join(link, 'not-yet-created') })).toThrow(
      /inside the repository/,
    );
  });

  it('refuses an explicit screenshot path inside the repository, and accepts one outside it', () => {
    expect(() => liveOutFile(path.join(repoRoot, 'shot.png'), 'x.png')).toThrow(/screenshot path is inside/);
    expect(liveOutFile(path.join(dir, 'shot.png'), 'x.png')).toBe(path.join(dir, 'shot.png'));
    expect(() => assertOutsideRepo(dir)).not.toThrow();
  });

  it('makes an existing output root private (mkdir only sets the mode on directories it creates)', () => {
    const root = path.join(dir, 'existing');
    mkdirSync(root, { mode: 0o755 });
    vi.stubEnv('AF_LIVE_OUT', root);
    liveOutDir('shots');
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });
});
