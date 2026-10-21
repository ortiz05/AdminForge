import path from 'node:path';
import {
  MAX_PATTERN_INPUT,
  Param,
  contentPattern,
  loadContentDir,
  patternProblem,
  testContentPattern,
} from '@adminforge/schemas';
import { repoRoot } from '../../lib/repo';

// Content patterns run synchronously on the API's one event loop, where nothing can interrupt them (security review
// S-14): validate refuses nested repetition and backreferences, every side anchors the same way, and long values
// never reach a pattern.
describe('content patterns', () => {
  it.each([
    ['(a+)+$'],
    ['(a*)*'],
    ['(\\w+\\s?)*'],
    ['(?:(?:ab)+)+'],
    // A separator the inner part can also match, or an optional one, still splits a value many ways.
    ['(-[a-z-]+)*'],
    ['(\\.?[a-z]+)+'],
    ['([a-z]+[.a-z])+'],
    ['((x+))*'],
    ['(a+){1,100}'],
  ])('refuses nested repetition: %s', (p) => {
    expect(patternProblem(p)).toMatch(/repeats a group that itself repeats/);
  });

  it('refuses backreferences, invalid expressions, u-mode errors and long patterns', () => {
    expect(patternProblem('(a)\\1')).toMatch(/backreference/);
    expect(patternProblem('(?<x>a)\\k<x>')).toMatch(/backreference/);
    expect(patternProblem('[a-')).toMatch(/not a valid regular expression/);
    expect(patternProblem('\\-')).toMatch(/not a valid regular expression/);
    expect(patternProblem('a{2')).toMatch(/not a valid regular expression/);
    expect(patternProblem('a'.repeat(513))).toMatch(/longer than 512/);
  });

  it.each([
    ['^[A-Za-z0-9._-]{1,64}$'],
    ['[A-Za-z0-9 _.:@+=-]{1,128}'],
    [
      '^/(subscriptions/[0-9a-fA-F-]{36}(/.*)?|providers/[Mm]icrosoft\\.[Mm]anagement/management[Gg]roups/[^/]+)$',
    ],
    ['(\\d{1,3}\\.){3}\\d{1,3}'],
    // Every pass starts or ends with a character the inner part can't match: one way to split a value.
    ['^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*$'],
    ['([a-z0-9-]{1,63}\\.)+[a-z]{2,}'],
    ['(/[^/]+)+'],
    ['(?=.{1,253}$)[a-z0-9.-]+'],
    ['(?:Include|Exclude)+'],
    ['\\p{L}+'],
    ['[^<>%&\\\\?/]+'],
  ])('accepts ordinary patterns: %s', (p) => {
    expect(patternProblem(p)).toBeUndefined();
  });

  it('one anchoring rule: the whole value must match, with or without ^…$', () => {
    expect(testContentPattern('[0-9]+', '42')).toBe('match');
    expect(testContentPattern('[0-9]+', 'a42')).toBe('mismatch');
    expect(testContentPattern('^[0-9]+$', '42')).toBe('match');
    // A top-level alternative is anchored as a whole, not just its first branch.
    expect(testContentPattern('a|b', 'ab')).toBe('mismatch');
    expect(contentPattern('a|b')!.source).toBe('^(?:a|b)$');
  });

  it('values over the cap never reach the pattern; refused patterns never compile', () => {
    expect(testContentPattern('.*', 'x'.repeat(MAX_PATTERN_INPUT))).toBe('match');
    expect(testContentPattern('.*', 'x'.repeat(MAX_PATTERN_INPUT + 1))).toBe('too_long');
    expect(contentPattern('(a+)+$')).toBeNull();
    expect(testContentPattern('(a+)+$', 'aaaa')).toBe('invalid');
  });

  it('an accepted separated pattern stays fast on an adversarial value at the length cap', () => {
    const started = performance.now();
    expect(testContentPattern('^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*$', `${'a.'.repeat(2000)}a!`)).toBe(
      'mismatch',
    );
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('the param schema refuses an unsafe pattern with the reason', () => {
    const r = Param.safeParse({ type: 'string', pattern: '(a+)+$' });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]).toMatchObject({ path: ['pattern'] });
    expect(r.error!.issues[0]!.message).toMatch(/repeats a group/);
    expect(Param.safeParse({ type: 'string', pattern: '^[0-9]+$' }).success).toBe(true);
  });

  it('every pattern in portal/content is allowed', async () => {
    const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
    const patterns: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (o.type === 'string' && typeof o.pattern === 'string') patterns.push(o.pattern);
        Object.values(o).forEach(walk);
      }
    };
    expect(loaded.errors.filter((e) => /pattern/.test(e.path))).toEqual([]);
    for (const d of loaded.definitions) walk(d.def);
    expect(patterns.length).toBeGreaterThan(40);
    expect(patterns.filter((p) => patternProblem(p))).toEqual([]);
  });
});
