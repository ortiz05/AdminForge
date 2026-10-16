import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../../lib/repo';
import { SCOPES, TYPES } from '../../../tooling/git/commit-message.mjs';

// The commit-message types and scopes live in three places: the check (tooling/git/commit-message.mjs), the guide
// engineers read (docs/onboarding/10-git-and-pull-requests.md) and the editor template
// (docs/onboarding/templates/commit-message.txt). A new scope goes into all three in the same change.
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');
const sorted = (list: readonly string[]) => [...list].sort();

/** Scopes listed in the guide's "### Scopes" section (the backticked words of its bullet list). */
function guideScopes(): string[] {
  const guide = read('docs/onboarding/10-git-and-pull-requests.md');
  const section = /^### Scopes\n([\s\S]*?)(?=^#{2,3} )/m.exec(guide)?.[1] ?? '';
  const bullets = section.split(/\n(?=- )/).filter((b) => b.startsWith('- '));
  return bullets.flatMap((b) =>
    [...b.replace(/\*\*[^*]+\*\*/g, '').matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]!),
  );
}

/** Types listed in the guide's "### Types" table. */
function guideTypes(): string[] {
  const guide = read('docs/onboarding/10-git-and-pull-requests.md');
  const section = /^### Types\n([\s\S]*?)(?=^#{2,3} )/m.exec(guide)?.[1] ?? '';
  return [...section.matchAll(/^\| `([a-z]+)` /gm)].map((m) => m[1]!);
}

/** The `# Label:` lines of the editor template, continuation lines included, up to the parenthesised note. */
function templateList(label: 'Types' | 'Scopes'): string[] {
  const lines = read('docs/onboarding/templates/commit-message.txt').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`# ${label}:`));
  if (start === -1) return [];
  const words: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (i > start && !/^#\s{2,}\S/.test(line)) break;
    const text = line
      .replace(/^#\s*/, '')
      .replace(new RegExp(`^${label}:`), '')
      .replace(/\(.*$/, '');
    words.push(...text.split(/\s+/).filter(Boolean));
  }
  return words;
}

describe('commit-message scopes and types stay in sync', () => {
  it('the guide lists exactly the scopes the check accepts', () => {
    expect(sorted(guideScopes())).toEqual(sorted(SCOPES));
  });

  it('the editor template lists exactly the scopes the check accepts', () => {
    expect(sorted(templateList('Scopes'))).toEqual(sorted(SCOPES));
  });

  it('the guide and the template list exactly the types the check accepts', () => {
    expect(sorted(guideTypes())).toEqual(sorted(TYPES));
    expect(sorted(templateList('Types'))).toEqual(sorted(TYPES));
  });

  it('no scope or type is listed twice', () => {
    expect(new Set(SCOPES).size).toBe(SCOPES.length);
    expect(new Set(TYPES).size).toBe(TYPES.length);
  });
});
