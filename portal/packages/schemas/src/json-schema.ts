import { z } from 'zod';
import type { Kind } from './common';
import { DEFINITION_SCHEMAS, Definition } from './definition';

type JsonSchema = Record<string, unknown>;

/** Draft-07 for the widest editor support (VS Code YAML / yaml-language-server). Input types, so defaults stay optional. */
const toJson = (schema: z.ZodType, title: string): JsonSchema => {
  const out = z.toJSONSchema(schema, { target: 'draft-07', io: 'input', unrepresentable: 'any', reused: 'ref' }) as JsonSchema;
  return { ...out, title };
};

/** JSON Schema per kind, plus `definition` (any kind). */
export function jsonSchemas(): Record<Kind | 'definition', JsonSchema> {
  const out = {} as Record<Kind | 'definition', JsonSchema>;
  for (const [kind, schema] of Object.entries(DEFINITION_SCHEMAS) as Array<[Kind, z.ZodType]>) out[kind] = toJson(schema, `AdminForge ${kind}`);
  out.definition = toJson(Definition, 'AdminForge definition');
  return out;
}
