import path from 'node:path';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// What a form or a filter says about a field — its label, description and placeholder — is read by whoever fills it
// in, and the portal's text names no configuration keys (CLAUDE.md rule 10; summaries-no-env-keys.test.ts covers
// titles and summaries). Seven definitions explained a default by its key ("AF_COST_TAG_NAME", "AF_PRIMARY_DOMAIN"),
// and `identity.adminforge-group-changes` told Readers to run `pnpm adminforge provision entra` (content review N6):
// they say it in words now.

const ENV_KEY = /\bAF_[A-Z0-9_]+/;
const CLI = /\bpnpm\b|`adminforge\b/;

interface Field {
  label?: unknown;
  description?: unknown;
  placeholder?: unknown;
}
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const active = loaded.definitions
  .map((d) => d.def as { id: string; kind: string; status?: string } & Record<string, unknown>)
  .filter((d) => d.status !== 'retired' && d.status !== 'draft');

/** Every param, input and manual-step input of a definition, as `id › path` with the text people read. */
function fields(def: Record<string, unknown>, id: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const add = (where: string, group: unknown) => {
    for (const [name, f] of Object.entries((group ?? {}) as Record<string, Field>))
      for (const key of ['label', 'description', 'placeholder'] as const)
        if (typeof f?.[key] === 'string') out.push([`${id} › ${where}.${name}.${key}`, f[key] as string]);
  };
  add('params', def.params);
  add('inputs', def.inputs);
  const walk = (v: unknown, at: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === 'object') {
      const step = v as { type?: string; id?: string; inputs?: unknown };
      if (step.type === 'manual') add(`${at}.inputs`, step.inputs);
      for (const [k, x] of Object.entries(v)) if (k !== 'tests') walk(x, `${at}.${k}`);
    }
  };
  walk(def.steps, 'steps');
  walk(def.sections, 'sections');
  return out;
}

/** Markdown and other text widgets show on pages, reports and dashboards (layout and tabs). */
function widgetTexts(def: Record<string, unknown>, id: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (v: unknown, at: string) => {
    if (typeof v === 'string') out.push([`${id} › ${at}`, v]);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
  };
  walk(def.layout, 'layout');
  walk(def.tabs, 'tabs');
  return out;
}

describe('the text of fields and widgets names no configuration keys or CLI commands', () => {
  it('fields: labels, descriptions and placeholders name no configuration key', () => {
    const all = active.flatMap((d) => fields(d, d.id));
    expect(all.length).toBeGreaterThan(500);
    expect(all.filter(([, text]) => ENV_KEY.test(text)).map(([at]) => at)).toEqual([]);
  });

  it('widgets tell nobody to run a CLI command', () => {
    const shown = active
      .filter((d) => ['page', 'report', 'dashboard'].includes(d.kind))
      .flatMap((d) => widgetTexts(d, d.id));
    expect(shown.filter(([, text]) => CLI.test(text)).map(([at]) => at)).toEqual([]);
  });
});
