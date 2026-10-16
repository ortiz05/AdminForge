/**
 * Design-token patterns: the one definition of "UI code", "raw colour" and "arbitrary Tailwind value"
 * (CLAUDE.md rule 5 — colours and sizes come from @adminforge/design-tokens only).
 *
 * Three checks enforce the rule at different moments, and all of them read these patterns:
 *   - tooling/lint/eslint.config.js       `pnpm lint`: string literals and template text in UI TypeScript
 *   - tests/guards/design-tokens.test.ts  `pnpm guard` (CI, pre-commit): every committable UI file, line by line
 *   - .claude/hooks/after-edit.mjs        the UI file Claude Code just wrote
 * tests/unit/tooling/design-token-patterns.test.ts keeps them in agreement.
 *
 * The patterns are kept as source strings too because ESLint takes them inside `no-restricted-syntax` selectors
 * (esquery `/regex/` literals): they must not contain a `/`.
 */

/** UI source files the rule applies to (repository-relative, `/`-separated). CSS is checked by the guard and hook. */
export const UI_FILE = /^portal\/(apps\/web\/src|packages\/(ui|widgets)\/src)\/.+\.(tsx?|css)$/;

/** The same UI TypeScript as ESLint `files` globs (ESLint doesn't parse CSS). */
export const UI_LINT_GLOBS = [
  'portal/apps/web/src/**/*.{ts,tsx}',
  'portal/packages/{ui,widgets}/src/**/*.{ts,tsx}',
];

/**
 * Hex (#rgb, #rrggbb), rgb()/rgba(), hsl()/hsla() and oklch() colours. A 3-digit hex followed by a word character or
 * `-` is not a colour (`#abc-def` anchors, `#fff1` ids).
 */
export const RAW_COLOUR_SOURCE =
  '#[0-9a-fA-F]{6}\\b|#[0-9a-fA-F]{3}\\b(?![\\w-])|\\brgba?\\(|\\bhsla?\\(|\\boklch\\(';

/** A Tailwind utility with an arbitrary value: `w-[13px]`, `bg-[#123456]`, `grid-cols-[1fr_2fr]`. */
export const ARBITRARY_VALUE_SOURCE = '\\b[a-z][a-z-]*-\\[[^\\]\\s]+\\]';

export const RAW_COLOUR = new RegExp(RAW_COLOUR_SOURCE);
export const ARBITRARY_VALUE = new RegExp(ARBITRARY_VALUE_SOURCE);

/** What each check tells the engineer. */
export const MESSAGES = {
  rawColour: 'Raw colour: use a design token (bg-panel, text-fg-2, var(--af-…)).',
  arbitraryValue: 'Arbitrary Tailwind value: use a token, or add one in portal/packages/design-tokens.',
};

/**
 * True for a repository-relative path the design-token rule covers.
 * @param {string} rel
 * @returns {boolean}
 */
export function isUiFile(rel) {
  return UI_FILE.test(rel);
}

/**
 * Every raw colour and arbitrary Tailwind value in a file's text, one entry per offending line and kind, in line order.
 * @param {string} text
 * @returns {Array<{ line: number; kind: 'rawColour' | 'arbitraryValue'; text: string }>}
 */
export function findTokenViolations(text) {
  const found = [];
  text.split('\n').forEach((content, i) => {
    if (RAW_COLOUR.test(content)) found.push({ line: i + 1, kind: 'rawColour', text: content.trim() });
    if (ARBITRARY_VALUE.test(content))
      found.push({ line: i + 1, kind: 'arbitraryValue', text: content.trim() });
  });
  return found;
}
