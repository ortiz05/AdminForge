import { confirmationMatches, normalizeConfirmation, unusualCharacters } from '@adminforge/schemas';

// Typed confirmations compare one way in the browser and on the server (platform review: the browser compared
// exactly, the server trimmed and lower-cased). An app's display name is chosen by whoever registered it, so the
// expected text may carry invisible or look-alike characters: the comparison ignores what can't be seen, and the
// person is told about every character that isn't plain. (Escapes only: no invisible characters in this source.)
const ZWSP = '\u{200b}';
const CYRILLIC_A = '\u{430}';

describe('typed confirmation text', () => {
  it('ignores case, surrounding and repeated whitespace', () => {
    expect(confirmationMatches('  A.LEE@example.com ', 'a.lee@example.com')).toBe(true);
    expect(confirmationMatches('Legacy   Automation', 'Legacy Automation')).toBe(true);
    expect(confirmationMatches('legacy\tautomation', 'Legacy Automation')).toBe(true);
    expect(confirmationMatches('LegacyAutomation', 'Legacy Automation')).toBe(false);
  });

  it('ignores invisible format characters on either side (zero-width, joiners, bidi controls, BOM, soft hyphen)', () => {
    const name = `PDF${ZWSP} Con\u{200d}verter\u{2060} On\u{ad}line\u{202e}\u{feff}`;
    expect(confirmationMatches('PDF Converter Online', name)).toBe(true);
    expect(confirmationMatches(`P${ZWSP}D\u{200c}F Converter Online`, 'PDF Converter Online')).toBe(true);
    expect(normalizeConfirmation(name)).toBe('pdf converter online');
  });

  it('applies Unicode NFKC: full-width and compatibility forms count as the plain letters', () => {
    expect(
      confirmationMatches('\u{ff2c}\u{ff45}\u{ff47}\u{ff41}\u{ff43}\u{ff59} Automation', 'Legacy Automation'),
    ).toBe(true);
    expect(confirmationMatches('\u{fb01}nance', 'finance')).toBe(true);
    expect(confirmationMatches('Legacy\u{a0}Automation', 'Legacy Automation')).toBe(true);
    // Composed and decomposed accents are the same text, even with an invisible character between them.
    expect(confirmationMatches('Zoe\u{308}', 'Zo\u{eb}')).toBe(true);
    expect(confirmationMatches('Zo\u{eb}', `Zoe${ZWSP}\u{308}`)).toBe(true);
    // Case folding beyond ASCII.
    expect(confirmationMatches('STRASSE', 'stra\u{df}e')).toBe(true);
    expect(confirmationMatches('\u{39f}\u{394}\u{39f}\u{3a3}', '\u{3bf}\u{3b4}\u{3bf}\u{3c2}')).toBe(true);
  });

  it('keeps look-alike letters from other scripts distinct (they must be noticed, not matched)', () => {
    expect(confirmationMatches('Microsoft Teams', `Microsoft Te${CYRILLIC_A}ms`)).toBe(false);
    expect(confirmationMatches(`Microsoft Te${CYRILLIC_A}ms`, `Microsoft Te${CYRILLIC_A}ms`)).toBe(true);
  });

  it('never matches an empty or invisible-only expected value, or a missing answer', () => {
    expect(confirmationMatches('', '')).toBe(false);
    expect(confirmationMatches(ZWSP, `${ZWSP} `)).toBe(false);
    expect(confirmationMatches(undefined, 'a')).toBe(false);
    expect(confirmationMatches(null, 'a')).toBe(false);
    expect(confirmationMatches('2', ' 2 ')).toBe(true);
    expect(confirmationMatches('\u{ff12}', '2')).toBe(true);
  });
});

describe('unusual characters in the text to type', () => {
  it('lists nothing for plain text (ASCII letters, digits, spaces and punctuation)', () => {
    expect(unusualCharacters('a.lee@example.com')).toEqual([]);
    expect(unusualCharacters("O'Brien & Sons (HR) #2")).toEqual([]);
  });

  it('names look-alikes by script and code point, once each', () => {
    expect(unusualCharacters(`Micr\u{43e}soft Te${CYRILLIC_A}ms ${CYRILLIC_A}`)).toEqual([
      {
        char: '\u{43e}',
        codePoint: 'U+043E',
        kind: 'Cyrillic letter',
        script: 'Cyrillic',
        invisible: false,
        misleading: true,
      },
      {
        char: CYRILLIC_A,
        codePoint: 'U+0430',
        kind: 'Cyrillic letter',
        script: 'Cyrillic',
        invisible: false,
        misleading: true,
      },
    ]);
    expect(unusualCharacters('\u{391}zure')[0]).toMatchObject({
      codePoint: 'U+0391',
      kind: 'Greek letter',
      misleading: true,
    });
  });

  it('a plain Latin letter mixed into a Cyrillic name is a look-alike too', () => {
    // "Moskva" in Cyrillic, with a Latin "o".
    expect(unusualCharacters('\u{41c}o\u{441}\u{43a}\u{432}\u{430}').filter((c) => c.misleading)).toEqual([
      {
        char: 'o',
        codePoint: 'U+006F',
        kind: 'Latin letter',
        script: 'Latin',
        invisible: false,
        misleading: true,
      },
    ]);
    // All Cyrillic: hard to type on a Latin keyboard, nothing misleading.
    expect(unusualCharacters('\u{41c}\u{43e}\u{441}\u{43a}\u{432}\u{430}').some((c) => c.misleading)).toBe(
      false,
    );
  });

  it('accents, curly quotes, symbols and other writing systems are only hard to type', () => {
    for (const name of [
      'M\u{fc}ller',
      'Contoso\u{2019}s HR App',
      'Caf\u{e9} Booking\u{2122}',
      'Pixel 8 \u{2013} M. Chen',
      '\u{4f1a}\u{8b70}\u{5ba4}\u{306e}\u{4e88}\u{7d04} Teams',
    ]) {
      const found = unusualCharacters(name);
      expect(found.length, name).toBeGreaterThan(0);
      expect(
        found.filter((c) => c.misleading),
        name,
      ).toEqual([]);
    }
    expect(unusualCharacters('M\u{fc}ller')[0]).toMatchObject({
      codePoint: 'U+00FC',
      kind: 'Latin letter',
      script: 'Latin',
    });
  });

  it('marks invisible characters and unusual spaces', () => {
    expect(unusualCharacters(`PDF${ZWSP}Converter`)).toEqual([
      {
        char: ZWSP,
        codePoint: 'U+200B',
        kind: 'invisible character',
        script: null,
        invisible: true,
        misleading: true,
      },
    ]);
    expect(unusualCharacters('a\u{202e}b')[0]).toMatchObject({ invisible: true, codePoint: 'U+202E' });
    expect(unusualCharacters('a\u{a0}b')[0]).toMatchObject({
      kind: 'space',
      invisible: false,
      misleading: true,
    });
  });

  it('says what a compatibility form stands for', () => {
    expect(unusualCharacters('\u{ff21}pp')[0]).toMatchObject({
      codePoint: 'U+FF21',
      kind: 'different form of \u{201c}A\u{201d}',
      invisible: false,
      misleading: true,
    });
  });

  it('handles characters outside the Basic Multilingual Plane', () => {
    expect(unusualCharacters('\u{1d400}pp')[0]).toMatchObject({
      char: '\u{1d400}',
      codePoint: 'U+1D400',
      kind: 'different form of \u{201c}A\u{201d}',
    });
    expect(unusualCharacters('a\u{e0041}')[0]).toMatchObject({ codePoint: 'U+E0041', invisible: true });
  });
});
