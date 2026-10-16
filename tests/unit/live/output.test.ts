import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { repoRoot } from '@adminforge/config';
import { liveOutDir, liveOutRoot } from '../../live/lib/output';

// Where live output goes (tests/live/lib/output.ts): private to the user, never inside the repository.

describe('liveOutRoot', () => {
  it('uses AF_LIVE_OUT when set', () => {
    expect(liveOutRoot({ AF_LIVE_OUT: '/srv/af-live' })).toBe('/srv/af-live');
  });

  it("defaults to the user's cache directory, not the shared /tmp", () => {
    expect(liveOutRoot({ XDG_CACHE_HOME: '/home/x/.cache' })).toBe('/home/x/.cache/adminforge/live');
    expect(liveOutRoot({})).toBe(path.join(homedir(), '.cache', 'adminforge', 'live'));
  });

  it('refuses a directory inside the repository (screenshots can show tenant data)', () => {
    expect(() => liveOutRoot({ AF_LIVE_OUT: path.join(repoRoot, 'tests', 'live-out') })).toThrow(
      /inside the repository/,
    );
    expect(() => liveOutRoot({ AF_LIVE_OUT: repoRoot })).toThrow(/inside the repository/);
  });
});

describe('liveOutDir', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'af-live-out-'));
    vi.stubEnv('AF_LIVE_OUT', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the directory for the owner only', () => {
    const shots = liveOutDir('shots');
    expect(shots).toBe(path.join(dir, 'shots'));
    expect(statSync(shots).mode & 0o777).toBe(0o700);
  });
});
