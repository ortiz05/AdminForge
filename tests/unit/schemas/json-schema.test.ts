import { jsonSchemas, KINDS } from '@adminforge/schemas';

describe('JSON Schema export', () => {
  const schemas = jsonSchemas();
  it('emits one draft-07 schema per kind plus the union', () => {
    expect(Object.keys(schemas).sort()).toEqual([...KINDS, 'definition'].sort());
    for (const s of Object.values(schemas)) expect(s.$schema).toBe('http://json-schema.org/draft-07/schema#');
  });
  it('marks envelope fields required and keeps defaults optional', () => {
    const pb = schemas.playbook as { required: string[]; properties: Record<string, unknown> };
    expect(pb.required).toEqual(
      expect.arrayContaining(['kind', 'id', 'version', 'title', 'owner', 'risk', 'mode', 'steps']),
    );
    expect((schemas.schedule as { required: string[] }).required).not.toContain('timezone');
  });
  it('represents recursive steps with $ref definitions', () => {
    const text = JSON.stringify(schemas.playbook);
    expect(text).toContain('"$ref":"#/definitions/');
    expect(Object.keys((schemas.playbook as { definitions: object }).definitions).length).toBeGreaterThan(0);
  });
  it('keeps patterns for editor validation', () =>
    expect(JSON.stringify(schemas.page)).toContain('^[a-z][a-z0-9-]*(\\\\.[a-z0-9][a-z0-9-]*)+$'));
});
