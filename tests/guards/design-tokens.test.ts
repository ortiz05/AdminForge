import { committableFiles, readText } from '../lib/repo';
import { findTokenViolations, isUiFile } from '../../tooling/lint/design-token-patterns.mjs';

// Central visual control: UI code may only use design tokens. The patterns are shared with ESLint and the Claude Code
// after-edit hook (tooling/lint/design-token-patterns.mjs).
const files = committableFiles().filter(isUiFile);

function hits(kind: 'rawColour' | 'arbitraryValue'): string[] {
  return files.flatMap((f) =>
    findTokenViolations(readText(f) ?? '')
      .filter((v) => v.kind === kind)
      .map((v) => `${f}:${v.line}: ${v.text}`),
  );
}

describe('UI code uses design tokens only', () => {
  it('checks the UI source files', () => {
    expect(files.length).toBeGreaterThan(50);
  });
  it('has no raw colours', () => {
    expect(hits('rawColour')).toEqual([]);
  });
  it('has no arbitrary Tailwind values', () => {
    expect(hits('arbitraryValue')).toEqual([]);
  });
});
