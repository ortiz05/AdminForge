import type { Definition } from '@adminforge/schemas';

/** Keys that never leave the server, per kind (connection endpoints and audiences; webhook env references). */
const SERVER_ONLY: Partial<Record<Definition['kind'], string[]>> = {
  connection: ['baseUrl', 'audience', 'scopes'],
};

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Webhook targets are `${ env.X }` references to secret-bearing URLs (schedules); the client never needs them.
      if (k === 'webhook') continue;
      out[k] = strip(v);
    }
    return out;
  }
  return value;
}

/**
 * The copy of a definition the browser gets. Layout, columns, params, datasources (the client needs them to render
 * and to name provenance) stay; editor-only `$schema`, connection endpoints/audiences and webhook references go.
 * Definitions never contain resolved `${ env.X }` values — those are only rendered server-side.
 */
export function clientDefinition<D extends Definition>(def: D): Record<string, unknown> {
  const out = strip(def) as Record<string, unknown>;
  delete out.$schema;
  for (const key of SERVER_ONLY[def.kind] ?? []) delete out[key];
  return out;
}
