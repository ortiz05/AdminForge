import { jsonSchemas, type Definition } from '@adminforge/schemas';
import { ENVELOPE, errors, ok } from './helpers';

// F-11 (platform review 2026-10-21): content that hasn't run against a live tenant yet, or reads Microsoft Graph
// beta endpoints, says so with `preview: true` on any definition; the page header shows a quiet "Preview" badge and
// `adminforge validate` lists them.
const PAGE = `${ENVELOPE('page', 'test.preview')}template: dashboard\nlayout:\n  - { widget: markdown, text: Hello }\n`;
const PLAYBOOK = `${ENVELOPE('playbook', 'test.preview-run')}risk: low\nmode: read\nsteps:\n  - { id: me, type: graph, request: { path: /me } }\n`;

describe('preview flag', () => {
  it('is optional and absent by default', () => {
    expect((ok(PAGE) as Definition & { preview?: boolean }).preview).toBeUndefined();
  });

  it.each([
    ['page', PAGE],
    ['playbook', PLAYBOOK],
  ])('is accepted on a %s', (_kind, text) => {
    expect(ok(`${text}preview: true\n`).preview).toBe(true);
    expect(ok(`${text}preview: false\n`).preview).toBe(false);
  });

  it('is a boolean, not a date or a word', () => {
    expect(errors(`${PAGE}preview: yes please\n`).map((e) => e.path)).toEqual(['preview']);
    expect(errors(`${PAGE}preview: "2026-10-21"\n`).map((e) => e.path)).toEqual(['preview']);
  });

  it('is in the generated JSON schemas (editor autocomplete) with its meaning', () => {
    const schemas = jsonSchemas();
    type Node = { type?: string; description?: string; $ref?: string; allOf?: Node[] };
    for (const kind of ['page', 'dashboard', 'report', 'playbook', 'probe'] as const) {
      const schema = schemas[kind] as {
        properties?: Record<string, Node>;
        definitions?: Record<string, Node>;
      };
      // Follow `$ref` and `allOf` and merge what they say: the generator shares sub-schemas between properties.
      const flatten = (n: Node | undefined): Node => {
        if (!n) return {};
        const parts = [
          n.$ref ? flatten(schema.definitions?.[n.$ref.split('/').pop()!]) : {},
          ...(n.allOf ?? []).map(flatten),
        ];
        return {
          type: n.type ?? parts.find((p) => p.type)?.type,
          description: n.description ?? parts.find((p) => p.description)?.description,
        };
      };
      const node = flatten(schema.properties?.preview);
      expect(node.type, kind).toBe('boolean');
      expect(node.description, kind).toMatch(/live tenant/);
    }
  });
});
