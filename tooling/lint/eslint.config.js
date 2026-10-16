/**
 * ESLint flat config for the whole repository (`pnpm lint`, which runs the @adminforge/lint package's `lint` script).
 *
 * - TypeScript recommended rules and React hooks rules on every .ts/.tsx file; unused variables are errors unless
 *   prefixed with `_`.
 * - UI code (UI_LINT_GLOBS) may not use raw colours or arbitrary Tailwind values in string literals or template text:
 *   the patterns come from ./design-token-patterns.mjs, shared with tests/guards/design-tokens.test.ts and the
 *   Claude Code after-edit hook so all three agree.
 *
 * Lives in tooling/lint (its own package) because typescript-eslint needs TypeScript 6's classic compiler API while
 * the workspace uses TypeScript 7 — see package.json there.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import {
  ARBITRARY_VALUE_SOURCE,
  MESSAGES,
  RAW_COLOUR_SOURCE,
  UI_LINT_GLOBS,
} from './design-token-patterns.mjs';

// Central visual control: colours and sizes come from @adminforge/design-tokens only.
const tokenRules = {
  'no-restricted-syntax': [
    'error',
    { selector: `Literal[value=/${RAW_COLOUR_SOURCE}/]`, message: MESSAGES.rawColour },
    { selector: `TemplateElement[value.raw=/${RAW_COLOUR_SOURCE}/]`, message: MESSAGES.rawColour },
    { selector: `Literal[value=/${ARBITRARY_VALUE_SOURCE}/]`, message: MESSAGES.arbitraryValue },
    { selector: `TemplateElement[value.raw=/${ARBITRARY_VALUE_SOURCE}/]`, message: MESSAGES.arbitraryValue },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.gen.ts',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: [...UI_LINT_GLOBS],
    rules: tokenRules,
  },
  { files: ['**/*.{js,mjs,cjs}'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
);
