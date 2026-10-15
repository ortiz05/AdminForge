import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// Central visual control: colours and sizes come from @adminforge/design-tokens only.
const RAW_COLOR = '#[0-9a-fA-F]{6}\\b|#[0-9a-fA-F]{3}\\b|rgba?\\(|hsla?\\(|oklch\\(';
const ARBITRARY = '\\b[a-z-]+-\\[[^\\]]+\\]';
const tokenRules = {
  'no-restricted-syntax': [
    'error',
    {
      selector: `Literal[value=/${RAW_COLOR}/]`,
      message: 'Use a design token (bg-panel, text-fg, var(--af-…)) instead of a raw colour.',
    },
    {
      selector: `Literal[value=/${ARBITRARY}/]`,
      message: 'Arbitrary Tailwind values bypass the design system. Use or add a token.',
    },
    {
      selector: `TemplateElement[value.raw=/${ARBITRARY}/]`,
      message: 'Arbitrary Tailwind values bypass the design system. Use or add a token.',
    },
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
    files: ['portal/apps/web/**/*.{ts,tsx}', 'portal/packages/{ui,widgets}/**/*.{ts,tsx}'],
    rules: tokenRules,
  },
  { files: ['**/*.{js,mjs,cjs}'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
);
