import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../lib/repo';

// The distribution-list playbooks check typed addresses with a regex in an expression. `^[^\s@]+@[^\s@]+\.[^\s@]+$`
// backtracks quadratically (a 20,000-character `addresses` token took 504 ms in the run worker), and validate now
// refuses such a regex anywhere in an expression. The 1.0.1 patterns accept the same addresses except a local part over
// 64 characters or an empty domain label, in linear time.

const PLAYBOOKS = [
  'm365/add-distribution-list-members',
  'm365/remove-distribution-list-members',
  'm365/create-distribution-list',
];

/** The address regex a playbook passes to `$contains`. */
function addressPattern(file: string): RegExp {
  const text = readFileSync(path.join(repoRoot, 'portal/content/playbooks', `${file}.playbook.yaml`), 'utf8');
  const m = /\$contains\(\$, \/(\^\[\^\\s@.*?\$)\/\)/.exec(text);
  expect(m, file).not.toBeNull();
  return new RegExp(m![1]!);
}

describe.each(PLAYBOOKS)('%s address check', (file) => {
  const re = addressPattern(file);

  it('accepts addresses and refuses what is not one', () => {
    for (const ok of ['kim.lee@partner.example.com', 'a@b.co', 'first.last+tag@sub.example.org'])
      expect(re.test(ok), ok).toBe(true);
    for (const bad of [
      'kim.lee',
      'a@b',
      '@example.com',
      'a b@example.com',
      'a@b..com',
      'a@example.com.',
      'a@@b.com',
    ])
      expect(re.test(bad), bad).toBe(false);
    expect(re.test(`${'x'.repeat(65)}@example.com`)).toBe(false);
  });

  it('answers a 20,000-character token in linear time', { retry: 2 }, () => {
    const t0 = performance.now();
    for (const token of [
      `a@${'b.'.repeat(10_000)}!`,
      `${'a'.repeat(64)}@${'b'.repeat(20_000)}`,
      'a@'.repeat(10_000),
    ])
      re.test(token);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
