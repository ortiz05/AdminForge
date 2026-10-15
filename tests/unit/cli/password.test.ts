import { generatePassword } from '@adminforge/cli/src/provision/password';

describe('generatePassword', () => {
  it('meets Entra complexity: all four character classes, requested length', () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword(24);
      expect(p).toHaveLength(24);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it('avoids characters that break env files and shells', () => {
    for (let i = 0; i < 50; i++) expect(generatePassword()).not.toMatch(/[\s"'`#$\\]/);
  });

  it('is random', () => expect(new Set(Array.from({ length: 20 }, () => generatePassword())).size).toBe(20));

  it('refuses short passwords', () => expect(() => generatePassword(8)).toThrow(/at least 16/));
});
