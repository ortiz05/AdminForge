import { GUID_PATTERN, GUID_RE, isGuid } from '@adminforge/schemas';
import * as browser from '@adminforge/schemas/browser';

// One GUID check for every package (organization review O-07): the hyphenated 8-4-4-4-12 form, any case, nothing
// around it. The ~30 copies it replaced were all one of the two spellings below; the shared one must accept exactly
// what they accepted, or a call site changes behaviour.
const LOWER_I = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOTH_CASES = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('the shared GUID check', () => {
  it.each([
    ID,
    ID.toUpperCase(),
    '0F8FAD5B-d9cb-469F-a165-70867728950E',
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
  ])('accepts %s', (s) => {
    expect(isGuid(s)).toBe(true);
    expect(GUID_RE.test(s)).toBe(true);
  });

  it.each([
    ['braces', `{${ID}}`],
    ['no hyphens', ID.replaceAll('-', '')],
    ['a urn', `urn:uuid:${ID}`],
    ['leading space', ` ${ID}`],
    ['trailing newline', `${ID}\n`],
    ['a non-hex letter', ID.replace('f', 'g')],
    ['a short group', '0f8fad5-d9cb-469f-a165-70867728950e'],
    ['a long last group', `${ID}0`],
    ['hyphens moved', '0f8fad5bd-9cb-469f-a165-70867728950e'],
    ['full-width digits', ID.replace('0', '０')],
    ['empty', ''],
  ])('refuses %s', (_why, s) => {
    expect(isGuid(s)).toBe(false);
    expect(GUID_RE.test(s)).toBe(false);
  });

  it('refuses anything that is not a string (no coercion: an array holding a GUID is not one)', () => {
    for (const v of [undefined, null, 42, {}, [ID], { toString: () => ID }]) expect(isGuid(v)).toBe(false);
  });

  it('narrows to a string, and leaves a string that fails the check a string (not never)', () => {
    const v: unknown = ID;
    if (isGuid(v)) expect(v.toLowerCase()).toBe(ID);
    else throw new Error('expected a GUID');
    const s: string = 'not a guid';
    const t: string | undefined = s;
    if (!isGuid(s)) expect(s.toUpperCase()).toBe('NOT A GUID');
    if (!isGuid(t)) expect(t?.length).toBe(10);
  });

  it('is stateless (no g flag: the same answer every time)', () => {
    expect(GUID_RE.flags).toBe('');
    expect([GUID_RE.test(ID), GUID_RE.test(ID), GUID_RE.test(ID)]).toEqual([true, true, true]);
  });

  it('accepts exactly what both replaced spellings accepted', () => {
    // Every string of GUID length (and one either side) over an alphabet with the edge cases: both cases, a
    // non-hex letter, braces, whitespace and non-ASCII letters whose case folding could reach a–f.
    const alphabet = '0123456789abcdefABCDEFgG-{} ſKİａ';
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    const samples: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      // Mostly well-shaped (so the accepting side is exercised), with one or two characters swapped.
      const chars = [...ID.replace(/[0-9a-f]/g, () => '0123456789abcdefABCDEF'[rnd(22)]!)];
      for (let k = rnd(3); k > 0; k--) chars[rnd(chars.length)] = alphabet[rnd(alphabet.length)]!;
      const len = rnd(10);
      samples.push(len === 0 ? chars.join('').slice(1) : len === 1 ? `${chars.join('')}0` : chars.join(''));
    }
    expect(samples.filter(isGuid).length).toBeGreaterThan(1000);
    for (const s of samples) {
      expect(isGuid(s), s).toBe(LOWER_I.test(s));
      expect(isGuid(s), s).toBe(BOTH_CASES.test(s));
    }
  });

  it('GUID_PATTERN is the unanchored source, spelled for both cases (JSON Schema patterns take no flags)', () => {
    expect(GUID_RE.source).toBe(`^${GUID_PATTERN}$`);
    expect(new RegExp(GUID_PATTERN).test(`id: ${ID.toUpperCase()}.`)).toBe(true);
    const text = `two ids ${ID} and ${ID.toUpperCase()} in text`;
    expect([...text.matchAll(new RegExp(GUID_PATTERN, 'g'))].map((m) => m[0])).toEqual([
      ID,
      ID.toUpperCase(),
    ]);
  });

  it('is on the browser entry too', () => {
    expect(browser.isGuid).toBe(isGuid);
    expect(browser.GUID_RE).toBe(GUID_RE);
    expect(browser.GUID_PATTERN).toBe(GUID_PATTERN);
  });
});
