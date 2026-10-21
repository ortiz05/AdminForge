import { committableFiles, readText } from '../lib/repo';

// Two vitest projects are chosen by file name (tests/vitest.config.ts, tests/README.md): `*.scale.test.ts` runs in
// `scale` (after the others, one file at a time, so a wall-clock budget isn't failed by another file's load) and
// `*.pwsh.test.ts` in `pwsh` (real PowerShell, kept out of `unit`). A file that misses its suffix still runs, in the
// wrong project — these keep the names honest.
const tests = committableFiles()
  .filter((f) => /^tests\/.+\.test\.tsx?$/.test(f))
  .map((f) => f.slice('tests/'.length));

describe('test file names pick the right vitest project', () => {
  it('content-at-scale tests are *.scale.test.ts', () => {
    expect(tests.filter((f) => /(^|\/)content-at-scale/.test(f) && !f.endsWith('.scale.test.ts'))).toEqual(
      [],
    );
  });

  it('tests that start real pwsh are *.pwsh.test.ts', () => {
    const startsPwsh = (f: string) =>
      /\bfindPwsh\(|spawn(Sync)?\(\s*['"]pwsh['"]/.test(readText(`tests/${f}`) ?? '');
    expect(tests.filter((f) => !f.endsWith('.pwsh.test.ts') && startsPwsh(f))).toEqual([]);
  });

  it('scale and pwsh tests live in unit/, content/ or api/ (the projects that leave them out)', () => {
    expect(
      tests.filter((f) => /\.(scale|pwsh)\.test\.ts$/.test(f) && !/^(unit|content|api)\//.test(f)),
    ).toEqual([]);
  });
});
