import path from 'node:path';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Which changes confirm by typing a value the person recognises (playbook skill, step 5): one click is easy to give
// without reading, and in a bulk run it would apply to every selected row — a bulk run asks for the count instead.
//
// - High and critical playbooks and runbooks. `azure.remove-role-assignment` (1.1.0) and `identity.add-app-owner`
//   (1.3.0) were the last playbooks that asked for a click; the runbooks `identity.leaver` and
//   `identity.compromised-account` (content review S5) the last runbooks.
// - Anything offered as a bulk action from risk medium up (low-risk bulk actions may click). Eleven medium playbooks
//   asked for a click there, `endpoint.restart-device` for up to 100 devices at once (content review S6).
//
// What they ask for when the value is a name anyone can choose: typed-confirm-fallback.test.ts.

type Confirm = { type?: string; value?: string; message?: string };
interface Automation {
  id: string;
  kind: string;
  status?: string;
  risk?: string;
  confirm?: Confirm;
}

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const live = loaded.definitions
  .map((d) => ({ file: d.file, def: d.def as unknown as Automation }))
  .filter((d) => d.def.status !== 'retired' && d.def.status !== 'draft');
const automations = live.map((d) => d.def).filter((d) => d.kind === 'playbook' || d.kind === 'runbook');
const byId = new Map<string, Automation>(automations.map((d) => [d.id, d]));

const typed = (d: Automation) => d.confirm?.type === 'typed' && !!d.confirm.value;
const atLeast = (risk: string | undefined, floor: 'medium' | 'high') =>
  floor === 'high' ? risk === 'high' || risk === 'critical' : risk !== undefined && risk !== 'low';

/** Every `bulkActions[].playbook` an active page, report or dashboard offers, with where it is offered. */
const bulk = new Map<string, Set<string>>();
const walk = (v: unknown, file: string) => {
  if (Array.isArray(v)) v.forEach((x) => walk(x, file));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      if (k === 'bulkActions' && Array.isArray(x))
        for (const a of x as Array<{ playbook?: string }>)
          if (a.playbook) bulk.set(a.playbook, (bulk.get(a.playbook) ?? new Set()).add(file));
      walk(x, file);
    }
};
for (const d of live) walk(d.def, d.file);

describe('confirmations by typing', () => {
  it('every high and critical playbook asks for a typed value', () => {
    const risky = automations.filter((p) => p.kind === 'playbook' && atLeast(p.risk, 'high'));
    expect(risky.length).toBeGreaterThan(20);
    expect(risky.filter((p) => !typed(p)).map((p) => p.id)).toEqual([]);
  });

  it('every high and critical runbook asks for a typed value', () => {
    const risky = automations.filter((p) => p.kind === 'runbook' && atLeast(p.risk, 'high'));
    expect(risky.map((p) => p.id)).toEqual(
      expect.arrayContaining(['identity.leaver', 'identity.compromised-account']),
    );
    expect(risky.filter((p) => !typed(p)).map((p) => p.id)).toEqual([]);
  });

  it('every bulk action of risk medium or higher asks for a typed value (the count, in bulk)', () => {
    expect(bulk.size).toBeGreaterThan(20);
    const offered = [...bulk.keys()].map((id) => byId.get(id)).filter((d): d is Automation => !!d);
    expect(offered.length).toBe(bulk.size);
    const medium = offered.filter((d) => atLeast(d.risk, 'medium'));
    expect(medium.map((d) => d.id)).toEqual(
      expect.arrayContaining(['endpoint.restart-device', 'avd.set-drain-mode']),
    );
    expect(
      medium.filter((d) => !typed(d)).map((d) => `${d.id} (${[...bulk.get(d.id)!].join(', ')})`),
    ).toEqual([]);
  });

  it('low-risk bulk actions may still click', () => {
    const low = [...bulk.keys()].map((id) => byId.get(id)!).filter((d) => d.risk === 'low');
    expect(low.map((d) => d.id)).toEqual(expect.arrayContaining(['azure.add-tags']));
  });
});
