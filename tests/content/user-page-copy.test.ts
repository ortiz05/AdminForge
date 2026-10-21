import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { repoRoot } from '../lib/repo';

// D-19 (a): what the user page shows reads as plain language — no Graph property names such as `signInActivity` in
// titles, descriptions, labels or summaries (the data references keep them; people never see those).
const file = path.join(repoRoot, 'portal/content/pages/identity/user.page.yaml');
const SHOWN = new Set(['title', 'description', 'label', 'summary', 'placeholder', 'empty', 'emptyText']);

function shownText(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => shownText(v, out));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      if (SHOWN.has(k) && typeof v === 'string') out.push(v);
      else shownText(v, out);
    }
  return out;
}

describe('identity.user copy', () => {
  it('names no Graph properties in what it shows', () => {
    const text = shownText(parse(readFileSync(file, 'utf8')));
    expect(text.length).toBeGreaterThan(20);
    expect(text.filter((t) => /signInActivity|\b[a-z]+[A-Z][a-zA-Z]*DateTime\b/.test(t))).toEqual([]);
  });

  it('says what the sign-in activity panel needs and how fresh it is', () => {
    expect(shownText(parse(readFileSync(file, 'utf8')))).toContain(
      'Needs Entra ID P1. Microsoft updates these times within a few hours of each sign-in.',
    );
  });
});
