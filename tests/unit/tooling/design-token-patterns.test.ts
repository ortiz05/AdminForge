import { createRequire } from 'node:module';
import path from 'node:path';
import { committableFiles, repoRoot } from '../../lib/repo';
import {
  ARBITRARY_VALUE,
  ARBITRARY_VALUE_SOURCE,
  findTokenViolations,
  isUiFile,
  MESSAGES,
  RAW_COLOUR,
  RAW_COLOUR_SOURCE,
  UI_LINT_GLOBS,
  type TokenViolationKind,
} from '../../../tooling/lint/design-token-patterns.mjs';
import { checksFor, runChecks } from '../../../.claude/hooks/after-edit.mjs';

// The design-token rule is enforced three times — ESLint (`pnpm lint`), the guard test (`pnpm guard`, CI, pre-commit)
// and the Claude Code after-edit hook — from one set of patterns (tooling/lint/design-token-patterns.mjs). These tests
// run the same samples through all three and check they decide alike, for the same files.

const SAMPLES: Array<[string, TokenViolationKind[]]> = [
  ['bg-[#123456]', ['rawColour', 'arbitraryValue']],
  ['#fff', ['rawColour']],
  ['#A1b2C3', ['rawColour']],
  ['rgba(0, 0, 0, 0.5)', ['rawColour']],
  ['rgb(0 0 0)', ['rawColour']],
  ['hsl(10 20% 30%)', ['rawColour']],
  ['oklch(0.7 0.1 200)', ['rawColour']],
  ['w-[13px]', ['arbitraryValue']],
  ['grid-cols-[1fr_2fr]', ['arbitraryValue']],
  ['bg-panel text-fg-2 border-line', []],
  ['h-(--af-control-h) var(--af-accent)', []],
  ['#abc-def', []],
  ['#fff1', []],
  ['see [the docs]', []],
  ['x-[a b]', []],
];

// ESLint lives in the tooling/lint package (TypeScript 6 toolchain), not in @adminforge/tests: load it from there.
interface LintMessage {
  ruleId: string | null;
  message: string;
}
interface ESLintModule {
  ESLint: new (opts: { cwd: string; overrideConfigFile: string }) => {
    lintText(code: string, opts: { filePath: string }): Promise<Array<{ messages: LintMessage[] }>>;
  };
}
const lintRequire = createRequire(path.join(repoRoot, 'tooling/lint/package.json'));
const { ESLint } = lintRequire('eslint') as ESLintModule;
const eslint = new ESLint({ cwd: repoRoot, overrideConfigFile: 'tooling/lint/eslint.config.js' });
const UI_FILE = 'portal/apps/web/src/__design-token-sample.tsx';

const kindOfMessage = (message: string): TokenViolationKind | undefined =>
  (Object.keys(MESSAGES) as TokenViolationKind[]).find((k) => MESSAGES[k] === message);

async function eslintKinds(code: string, filePath = UI_FILE): Promise<TokenViolationKind[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return [
    ...new Set(
      (result?.messages ?? [])
        .filter((m) => m.ruleId === 'no-restricted-syntax')
        .map((m) => kindOfMessage(m.message))
        .filter((k): k is TokenViolationKind => k !== undefined),
    ),
  ].sort();
}

function hookKinds(text: string): TokenViolationKind[] {
  const problems = runChecks(UI_FILE, {
    run: () => undefined,
    readFile: () => Buffer.from(text),
  });
  return [
    ...new Set(
      problems.map((p) => kindOfMessage(p.replace(/^[^:]+:\d+: /, ''))).filter((k) => k !== undefined),
    ),
  ].sort();
}

const guardKinds = (text: string) => [...new Set(findTokenViolations(text).map((v) => v.kind))].sort();

describe('design-token patterns', () => {
  it('compile from the source strings ESLint uses, which hold no "/" (esquery regex literals)', () => {
    expect(RAW_COLOUR.source).toBe(new RegExp(RAW_COLOUR_SOURCE).source);
    expect(ARBITRARY_VALUE.source).toBe(new RegExp(ARBITRARY_VALUE_SOURCE).source);
    expect(RAW_COLOUR_SOURCE).not.toContain('/');
    expect(ARBITRARY_VALUE_SOURCE).not.toContain('/');
  });

  it.each(SAMPLES)('the guard, ESLint and the after-edit hook agree on %j', async (sample, expected) => {
    const want = [...expected].sort();
    expect(guardKinds(`const s = '${sample}';`)).toEqual(want);
    expect(hookKinds(`const s = '${sample}';`)).toEqual(want);
    expect(await eslintKinds(`export const s = '${sample}';\n`)).toEqual(want);
    expect(await eslintKinds(`export const t = (x: string) => \`\${x} ${sample}\`;\n`)).toEqual(want);
  });

  it('ESLint applies the rule only to UI code', async () => {
    expect(
      await eslintKinds(`export const s = 'bg-[#123456]';\n`, 'portal/apps/api/src/__sample.ts'),
    ).toEqual([]);
    expect(await eslintKinds(`export const s = 'bg-[#123456]';\n`, 'tests/unit/__sample.ts')).toEqual([]);
  });

  it('the three checks cover the same files', () => {
    const files = committableFiles();
    const ui = files.filter(isUiFile);
    expect(ui.length).toBeGreaterThan(50);
    for (const f of files) {
      const lintable = /\.(ts|tsx)$/.test(f);
      const inLintScope = UI_LINT_GLOBS.some((g) => path.matchesGlob(f, g));
      // ESLint can't parse CSS: the guard and the hook check it.
      expect([f, lintable && isUiFile(f)]).toEqual([f, inLintScope]);
      expect([f, checksFor(f).designTokens]).toEqual([f, isUiFile(f)]);
    }
  });
});
