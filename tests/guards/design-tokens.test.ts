import { committableFiles, readText } from '../lib/repo';

// Central visual control: UI code may only use design tokens.
const SCOPES = /^portal\/(apps\/web\/src|packages\/(ui|widgets)\/src)\/.*\.(tsx?|css)$/;
const RAW_COLOR = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])|\brgba?\(|\bhsla?\(|\boklch\(/;
const ARBITRARY = /\b[a-z][a-z-]*-\[[^\]\s]+\]/;

const files = committableFiles().filter((f) => SCOPES.test(f));

describe('UI code uses design tokens only', () => {
  it('has no raw colours', () => {
    const hits = files.flatMap((f) => (readText(f) ?? '').split('\n').flatMap((line, i) => (RAW_COLOR.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : [])));
    expect(hits).toEqual([]);
  });
  it('has no arbitrary Tailwind values', () => {
    const hits = files.flatMap((f) => (readText(f) ?? '').split('\n').flatMap((line, i) => (ARBITRARY.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : [])));
    expect(hits).toEqual([]);
  });
});
