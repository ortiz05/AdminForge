import { parseDefinition, type ContentError, type Definition } from '@adminforge/schemas';

/** Strips the common indentation so line 1 is the first line of YAML. */
export function yaml(strings: TemplateStringsArray, ...values: unknown[]): string {
  const raw = strings.reduce((out, s, i) => out + s + (i < values.length ? String(values[i]) : ''), '');
  const lines = raw
    .replace(/^\n/, '')
    .replace(/\n\s*$/, '\n')
    .split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return lines.map((l) => l.slice(indent)).join('\n');
}

export function ok<T extends Definition = Definition>(text: string, file = 'test.yaml'): T {
  const r = parseDefinition(text, file);
  if (!r.ok)
    throw new Error(
      `Expected a valid definition, got:\n${r.errors.map((e) => `${e.line}:${e.path}: ${e.message}`).join('\n')}`,
    );
  return r.def as T;
}

export function errors(text: string, file = 'test.yaml'): ContentError[] {
  const r = parseDefinition(text, file);
  if (r.ok) throw new Error('Expected validation errors, got a valid definition');
  return r.errors;
}

/** `path@line: message` for compact assertions. */
export const brief = (e: ContentError[]) => e.map((x) => `${x.path}@${x.line}`);

export const ENVELOPE = (kind: string, id = 'test.example') =>
  `kind: ${kind}\nid: ${id}\nversion: 1.0.0\ntitle: Example\nowner: test-team\n`;
