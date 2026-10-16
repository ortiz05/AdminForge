import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '@adminforge/config';

// The live suite's global setup enables the validation user only — never the approver fixture, whose sign-in is
// turned on explicitly (`provision test-identities --enable --approver`) for approval tests. Teardown's `--disable`
// covers both accounts.

const read = (file: string) => readFileSync(path.join(repoRoot, 'tests/live/e2e', file), 'utf8');

describe('live global setup and teardown', () => {
  it('setup runs `provision test-identities --enable` without --approver', () => {
    const setup = read('global-setup.ts');
    expect(setup).toMatch(/\['-s', 'adminforge', 'provision', 'test-identities', '--enable'\]/);
    expect(setup).not.toMatch(/'--approver'/);
  });

  it('teardown runs `--disable`, which disables both accounts', () => {
    expect(read('global-teardown.ts')).toMatch(/'test-identities', '--disable'/);
  });
});
