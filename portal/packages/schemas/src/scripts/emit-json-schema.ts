import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jsonSchemas } from '../json-schema';

// Writes generated/<kind>.schema.json for editor autocomplete (`$schema:` in content files). The directory is git-ignored.
const out = fileURLToPath(new URL('../../generated/', import.meta.url));
mkdirSync(out, { recursive: true });
const schemas = jsonSchemas();
for (const [kind, schema] of Object.entries(schemas))
  writeFileSync(`${out}${kind}.schema.json`, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`schemas: wrote ${Object.keys(schemas).length} JSON Schemas to generated/`);
