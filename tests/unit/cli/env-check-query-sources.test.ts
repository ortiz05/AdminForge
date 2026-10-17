import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkEnv } from '@adminforge/cli/src/env/env-check';
import { repoRoot } from '../../lib/repo';

// AF_QUERY_SOURCES (Query Studio sources offered): `adminforge env check` flags the same names the API refuses at
// startup, so a typo shows up before the services restart.
const EXAMPLE = readFileSync(path.join(repoRoot, 'config', 'example.env'), 'utf8');
const key = (values: Record<string, string>) =>
  checkEnv(EXAMPLE, values).keys.find((k) => k.key === 'AF_QUERY_SOURCES')!;

describe('env check: AF_QUERY_SOURCES', () => {
  it('is documented in config/example.env and accepts known sources', () => {
    expect(key({})).toBeDefined();
    expect(key({ AF_QUERY_SOURCES: 'resourceGraph, logAnalytics' }).problem).toBeUndefined();
  });

  it('flags a list with no source in it (the API would refuse to start)', () => {
    expect(key({ AF_QUERY_SOURCES: ', ,' }).problem).toBe(
      'expected resourceGraph, logAnalytics, advancedHunting (comma-separated, at least one)',
    );
  });

  it('flags an unknown source', () => {
    expect(key({ AF_QUERY_SOURCES: 'resourceGraph,hunting' }).problem).toBe(
      'expected resourceGraph, logAnalytics, advancedHunting (comma-separated, at least one)',
    );
  });
});
