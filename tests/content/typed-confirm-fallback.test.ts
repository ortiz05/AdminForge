import path from 'node:path';
import { renderConfirm } from '@adminforge/api/src/runs/confirm';
import { renderTemplate } from '@adminforge/expressions';
import { loadContentDir, normalizeConfirmation } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Typed confirmations on names anyone can choose (security review L4, content review S1). The API never asks anyone to
// type a value with nothing visible in it or one that holds a masked value (`[redacted]`), so a preview of such a name
// could never be confirmed — and whoever registered an app (or created a group) could block a revocation that way.
// These playbooks work out what to ask for in a `confirmAs` step: the name when a person can type it, otherwise the
// object's id, which the message then shows. The two that remove things were converted from a click (content review
// S6: medium-risk bulk actions confirm by typing).

interface Step {
  id: string;
  type: string;
  expression?: string;
}
interface Def {
  id: string;
  confirm: { type: string; value: string; message: string };
  steps: Step[];
}

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const def = (id: string) => loaded.definitions.find((d) => d.def.id === id)!.def as unknown as Def;

/** Per playbook: the step outputs a preview stores, with the name to confirm set to `name`, and the id it falls back to. */
const CASES: Record<string, { steps: (name: string) => Record<string, { output: unknown }>; id: string }> = {
  'identity.revoke-consent-grant': {
    id: '00000000-0000-4000-8000-000000000404',
    steps: (name) => ({
      grant: { output: { consentType: 'Principal', scope: 'Mail.Read offline_access' } },
      client: { output: { id: '00000000-0000-4000-8000-000000000404', displayName: name } },
      resource: { output: { displayName: 'Microsoft Graph' } },
    }),
  },
  'identity.add-app-owner': {
    id: '00000000-0000-4000-8000-000000000301',
    steps: (name) => ({
      app: { output: { id: '00000000-0000-4000-8000-000000000301', displayName: name } },
      owner: { output: { userPrincipalName: 'm.chen@example.com' } },
    }),
  },
  'azure.remove-role-assignment': {
    id: '30000000-0000-4000-8000-000000000202',
    steps: (name) => ({
      lookup: {
        output: {
          name: '30000000-0000-4000-8000-000000000202',
          properties: {
            principalId: '30000000-0000-4000-8000-000000000102',
            principalType: 'User',
            scope: '/subscriptions/00000000-0000-4000-8000-0000000000a1',
          },
        },
      },
      role: { output: { properties: { roleName: name } } },
    }),
  },
  'identity.remove-expired-app-credentials': {
    id: '00000000-0000-4000-8000-000000000302',
    steps: (name) => ({
      app: { output: { id: '00000000-0000-4000-8000-000000000302', displayName: name } },
      expired: { output: { secrets: [{ label: 'ci (expired 2020-01-01)' }], certificates: [] } },
    }),
  },
  'identity.disable-enterprise-app': {
    id: '00000000-0000-4000-8000-000000000404',
    steps: (name) => ({
      sp: { output: { id: '00000000-0000-4000-8000-000000000404', displayName: name } },
    }),
  },
  'endpoint.restart-device': {
    id: '00000000-0000-4000-8000-000000000601',
    steps: (name) => ({
      device: {
        output: {
          id: '00000000-0000-4000-8000-000000000601',
          deviceName: name,
          userPrincipalName: 'a.lee@example.com',
        },
      },
    }),
  },
  'identity.remove-group-members': {
    id: '00000000-0000-4000-8000-000000000201',
    steps: (name) => ({
      group: { output: { id: '00000000-0000-4000-8000-000000000201', displayName: name } },
    }),
  },
};

/** The confirmation as the API renders it, after the playbook's own `confirmAs` step has run on `steps`. */
async function confirmation(id: string, name: string) {
  const d = def(id);
  const step = d.steps.find((s) => s.id === 'confirmAs');
  expect(step?.type, `${id}: a confirmAs transform`).toBe('transform');
  const steps = CASES[id]!.steps(name);
  const output = await renderTemplate(step!.expression!, { steps });
  return renderConfirm(d.confirm as never, { steps: { ...steps, confirmAs: { output } } }, []);
}

// Every character the API's comparison treats as nothing (the Basic Multilingual Plane; outside it the check is
// stricter still: surrogates never count as something to type), and control characters, which can't be typed either.
const INVISIBLE: string[] = [];
for (let c = 0; c <= 0xffff; c++) {
  if (c >= 0xd800 && c <= 0xdfff) continue;
  const ch = String.fromCharCode(c);
  if (normalizeConfirmation(ch) === '' || c < 0x20 || (c >= 0x7f && c <= 0x9f)) INVISIBLE.push(ch);
}

describe.each(Object.keys(CASES))('%s: typed confirmation of a name anyone can choose', (id) => {
  const { id: objectId } = CASES[id]!;

  it('asks for the name when it can be typed, and shows it', async () => {
    for (const name of ['Example HR Sync', 'Résumé Parser', '経費精算', 'Контроль доступа']) {
      const c = await confirmation(id, name);
      expect(c?.type).toBe('typed');
      expect(c?.value).toBe(name);
      expect(c?.message).toContain(name);
      expect(c?.message).not.toContain(objectId);
      // Dropped: the dialog's own label already says "Type … to confirm".
      expect(c?.message).not.toMatch(/Type .* to confirm\.?$/);
    }
  });

  it('asks for the object id, and shows it, when the name has nothing visible to type', async () => {
    expect(INVISIBLE.length).toBeGreaterThan(150);
    const names = [...INVISIBLE, '', '\u200b\u200b\u200b', ' \u00a0\u3000 ', '\u202e\u2066'];
    const wrong: string[] = [];
    for (const name of names) {
      const c = await confirmation(id, name);
      if (c?.value !== objectId || !c.message?.includes(objectId))
        wrong.push(`U+${[...name].map((x) => x.codePointAt(0)!.toString(16).padStart(4, '0')).join(' U+')}`);
    }
    expect(wrong).toEqual([]);
  });

  it('asks for the object id when the name holds a masked value', async () => {
    for (const name of ['[redacted]', 'Payroll [redacted] Sync']) {
      const c = await confirmation(id, name);
      expect(c?.value).toBe(objectId);
      expect(c?.message).toContain(objectId);
    }
  });

  it('asks for the object id when there is no name', async () => {
    const c = await confirmation(id, undefined as unknown as string);
    expect(c?.value).toBe(objectId);
    expect(c?.message).toContain(objectId);
    expect(c?.message).not.toMatch(/undefined/);
  });
});

describe('azure.remove-role-assignment when the role cannot be read', () => {
  it("asks for the assignment's GUID, which the message shows", async () => {
    const d = def('azure.remove-role-assignment');
    const steps = { ...CASES['azure.remove-role-assignment']!.steps('Owner'), role: {} };
    const output = await renderTemplate(d.steps.find((s) => s.id === 'confirmAs')!.expression!, { steps });
    const c = await renderConfirm(d.confirm as never, { steps: { ...steps, confirmAs: { output } } }, []);
    expect(c?.value).toBe('30000000-0000-4000-8000-000000000202');
    expect(c?.message).toBe(
      'Remove this role (assignment 30000000-0000-4000-8000-000000000202) from the user ' +
        '30000000-0000-4000-8000-000000000102 at /subscriptions/00000000-0000-4000-8000-0000000000a1? They lose the ' +
        'access it grants within a few minutes.',
    );
  });
});

describe('every confirmAs step', () => {
  // One check, copied: a playbook that falls back must use exactly this class, and be listed in CASES above so the
  // tests run against it (a generic `confirm.fallback` in the API would replace the copies: docs/backlog.md).
  const steps = loaded.definitions
    .map((d) => d.def as unknown as Def & { status?: string })
    .filter((d) => d.status !== 'retired' && Array.isArray(d.steps))
    .flatMap((d) =>
      d.steps.filter((s) => s.id === 'confirmAs').map((s) => [d.id, s.expression ?? ''] as const),
    );
  const classOf = (expression: string) => /\$contains\(\$name, (\/\[\^.*?\]\/)\)/.exec(expression)?.[1];

  it('is tested here', () => {
    expect(steps.map(([id]) => id).sort()).toEqual(Object.keys(CASES).sort());
  });

  it('uses the same character class', () => {
    const classes = new Set(steps.map(([, e]) => classOf(e)));
    expect(classes.size).toBe(1);
    expect([...classes][0]).toMatch(/^\/\[\^\\s/);
  });
});
