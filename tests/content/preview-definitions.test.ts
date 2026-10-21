import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseDefinition } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// F-19 (platform review 2026-10-21): `m365.teams-user-policies` doesn't work against a live tenant yet (the Teams
// PowerShell read path, docs/backlog.md). Until it does it stays reachable and says so: `preview: true`.
const file = path.join(repoRoot, 'portal/content/pages/m365/teams-user-policies.page.yaml');

describe('content flagged preview', () => {
  it('m365.teams-user-policies is an active preview', () => {
    const r = parseDefinition(readFileSync(file, 'utf8'), file);
    expect(r.ok && r.def.id).toBe('m365.teams-user-policies');
    expect(r.ok && r.def.preview).toBe(true);
    expect(r.ok && (r.def.status ?? 'active')).toBe('active');
  });
});
