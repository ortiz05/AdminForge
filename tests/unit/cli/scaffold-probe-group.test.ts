import { parseDefinition } from '@adminforge/schemas';
import { scaffold } from '@adminforge/cli/src/content/scaffold';

// `adminforge new probe <section>/<name>`: Synthetic monitoring groups probes by service, so a probe scaffolded in a
// navigation section gets that section as its `group`; elsewhere a placeholder says what to fill in.
const base = { kind: 'probe' as const, contentDir: '/content', schemasDir: '/schemas' };

describe('probe scaffold', () => {
  it('groups a probe under its section when the section is in the navigation', () => {
    const out = scaffold({ ...base, target: 'exchange/queue-depth', navSections: new Set(['exchange']) });
    const parsed = parseDefinition(out.yaml, 'probe.yaml');
    expect(parsed.ok && parsed.def).toMatchObject({ id: 'exchange.queue-depth', group: 'exchange' });
  });

  it('leaves a placeholder elsewhere', () => {
    const out = scaffold({ ...base, target: 'probes/queue-depth', navSections: new Set(['exchange']) });
    const parsed = parseDefinition(out.yaml, 'probe.yaml');
    expect(parsed.ok && 'group' in parsed.def).toBe(false);
    expect(out.yaml).toMatch(/# group: <navigation section key, or platform>/);
  });
});
