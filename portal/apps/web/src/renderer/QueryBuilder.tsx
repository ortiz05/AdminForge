import { useId, useState } from 'react';
import {
  advancedOpsFor,
  DEFAULT_ADVANCED_PARAM,
  type AdvancedField,
  type AdvancedOp,
  type FilterBar as FilterBarSpec,
} from '@adminforge/schemas';
import {
  Button,
  CaretDownIcon,
  Checkbox,
  FunnelSimpleIcon,
  IconButton,
  PlusIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  TextField,
  TrashIcon,
  WarningIcon,
  cn,
  filterBar,
} from '@adminforge/ui';

/**
 * The advanced filter (R9 query builder). The browser never writes OData or KQL: it sends a structured filter that the
 * BFF validates against `filters.advanced.fields` and compiles itself.
 *
 *   wire:  { "all": [ <clause>, … ] } | { "any": [ <clause>, … ] }
 *          clause = { "field", "op", "value"? } | one nested { "all" | "any": [ <condition>, … ] }
 *   URL:   ?<filters.advanced.param, default adv>=<base64url(JSON)>
 *   API:   params[<param>] = the JSON object
 *
 * Limits mirror the server: nesting ≤ 2, ≤ 20 conditions, `in` ≤ 50 values, strings ≤ 256 characters.
 */

export type AdvancedSpec = NonNullable<FilterBarSpec['advanced']>;
export type Scalar = string | number | boolean;
export interface WireCondition {
  field: string;
  op: AdvancedOp;
  value?: Scalar | Scalar[];
}
export type WireGroup = { all: Array<WireCondition | WireInner> } | { any: Array<WireCondition | WireInner> };
export type WireInner = { all: WireCondition[] } | { any: WireCondition[] };

export const MAX_CONDITIONS = 20;
export const MAX_IN_VALUES = 50;
export const MAX_STRING = 256;

export const advancedParamOf = (spec: AdvancedSpec) => spec.param ?? DEFAULT_ADVANCED_PARAM;

const OP_LABEL: Record<AdvancedOp, string> = {
  eq: 'is',
  ne: 'is not',
  gt: 'is after / greater than',
  ge: 'is on or after / at least',
  lt: 'is before / less than',
  le: 'is on or before / at most',
  startsWith: 'starts with',
  contains: 'contains',
  in: 'is one of',
  isEmpty: 'is empty',
};

// ── Wire encoding ───────────────────────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const joinOf = (g: Record<string, unknown>): 'all' | 'any' | undefined =>
  Array.isArray(g.all) && Object.keys(g).length === 1
    ? 'all'
    : Array.isArray(g.any) && Object.keys(g).length === 1
      ? 'any'
      : undefined;

export function encodeFilter(filter: WireGroup): string {
  const bytes = new TextEncoder().encode(JSON.stringify(filter));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** URL value (base64url), JSON text, or an object → the filter; undefined when absent or unreadable. */
export function decodeFilter(raw: unknown): WireGroup | undefined {
  let value = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return undefined;
    try {
      if (text.startsWith('{')) value = JSON.parse(text);
      else {
        const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
        value = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
      }
    } catch {
      return undefined;
    }
  }
  return isObject(value) && joinOf(value) ? (value as WireGroup) : undefined;
}

const clausesOf = (g: WireGroup | WireInner) =>
  ('all' in g ? g.all : g.any) as Array<WireCondition | WireInner>;

export function countConditions(g: WireGroup | undefined): number {
  if (!g) return 0;
  return clausesOf(g).reduce(
    (n, c) => n + (isObject(c) && joinOf(c) ? clausesOf(c as WireInner).length : 1),
    0,
  );
}

// ── Draft (what the form edits) ─────────────────────────────────────────────────────────────────────

export interface DraftCondition {
  kind: 'condition';
  field: string;
  op: AdvancedOp;
  /** Text input (string, number, date, guid, comma lists). */
  text: string;
  /** enum `in` and boolean picks. */
  picks: string[];
}
export interface DraftGroup {
  kind: 'group';
  join: 'all' | 'any';
  items: DraftCondition[];
}
export interface Draft {
  join: 'all' | 'any';
  items: Array<DraftCondition | DraftGroup>;
}

const fieldOf = (spec: AdvancedSpec, name: string) => spec.fields.find((f) => f.field === name);
const opsOf = (f: AdvancedField) => advancedOpsFor(f);

export function blankCondition(spec: AdvancedSpec, field?: AdvancedField): DraftCondition {
  const f = field ?? spec.fields[0]!;
  return { kind: 'condition', field: f.field, op: opsOf(f)[0]!, text: '', picks: [] };
}

function conditionFromWire(c: WireCondition): DraftCondition {
  const v = c.value;
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return {
    kind: 'condition',
    field: c.field,
    op: c.op,
    text: list.map(String).join(', '),
    picks: list.map(String),
  };
}

export function draftFromWire(spec: AdvancedSpec, g: WireGroup | undefined): Draft {
  if (!g) return { join: 'all', items: [blankCondition(spec)] };
  const items = clausesOf(g).map((c) =>
    isObject(c) && joinOf(c)
      ? ({
          kind: 'group',
          join: joinOf(c)!,
          items: clausesOf(c as WireInner).map((x) => conditionFromWire(x as WireCondition)),
        } as DraftGroup)
      : conditionFromWire(c as WireCondition),
  );
  return { join: 'all' in g ? 'all' : 'any', items: items.length ? items : [blankCondition(spec)] };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const RELATIVE_DATE = /^(today|now|[+-]\d+[hdwmy])$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** One typed value for a field, or the reason it isn't valid. */
export function typedValue(f: AdvancedField, raw: string): { value: Scalar } | { problem: string } {
  const v = raw.trim();
  switch (f.type) {
    case 'number':
      return v !== '' && Number.isFinite(Number(v)) ? { value: Number(v) } : { problem: 'Enter a number.' };
    case 'boolean':
      return v === 'true' || v === 'false' ? { value: v === 'true' } : { problem: 'Choose yes or no.' };
    case 'date':
      return ISO_DATE.test(v) || RELATIVE_DATE.test(v)
        ? { value: v }
        : { problem: 'Enter a date like 2026-01-31, or today, now, -30d.' };
    case 'guid':
      return GUID.test(v) ? { value: v.toLowerCase() } : { problem: 'Enter a GUID.' };
    case 'enum': {
      const hit = (f.values ?? []).find((x) => String(x) === v);
      return hit !== undefined
        ? { value: hit }
        : { problem: `Choose one of ${(f.values ?? []).join(', ')}.` };
    }
    default:
      if (!v) return { problem: 'Enter a value.' };
      if (v.length > MAX_STRING) return { problem: `Use at most ${MAX_STRING} characters.` };
      if (CONTROL.test(v)) return { problem: 'Control characters aren’t allowed.' };
      return { value: v };
  }
}

function conditionToWire(
  spec: AdvancedSpec,
  c: DraftCondition,
): { condition: WireCondition } | { problem: string } {
  const f = fieldOf(spec, c.field);
  if (!f) return { problem: 'Choose a field.' };
  if (!opsOf(f).includes(c.op)) return { problem: `${f.label} doesn’t support “${OP_LABEL[c.op]}”.` };
  if (c.op === 'isEmpty') return { condition: { field: f.field, op: 'isEmpty' } };
  if (c.op === 'in') {
    const raws =
      f.type === 'enum' || f.type === 'boolean'
        ? c.picks
        : c.text
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
    if (!raws.length) return { problem: 'Add at least one value.' };
    if (raws.length > MAX_IN_VALUES) return { problem: `Use at most ${MAX_IN_VALUES} values.` };
    const values: Scalar[] = [];
    for (const r of raws) {
      const t = typedValue(f, r);
      if ('problem' in t) return { problem: `“${r}”: ${t.problem}` };
      values.push(t.value);
    }
    return { condition: { field: f.field, op: 'in', value: values } };
  }
  const t = typedValue(f, f.type === 'enum' || f.type === 'boolean' ? (c.picks[0] ?? '') : c.text);
  return 'problem' in t ? t : { condition: { field: f.field, op: c.op, value: t.value } };
}

export interface DraftProblems {
  /** Key `i` or `i.j` (condition j in group i) → problem. */
  byCondition: Record<string, string>;
  general: string[];
}

/** Draft → wire filter (undefined when empty), or every problem keyed by condition. */
export function draftToWire(spec: AdvancedSpec, d: Draft): { filter?: WireGroup; problems: DraftProblems } {
  const problems: DraftProblems = { byCondition: {}, general: [] };
  const out: Array<WireCondition | WireInner> = [];
  let count = 0;
  d.items.forEach((item, i) => {
    if (item.kind === 'group') {
      const inner: WireCondition[] = [];
      item.items.forEach((c, j) => {
        count++;
        const r = conditionToWire(spec, c);
        if ('problem' in r) problems.byCondition[`${i}.${j}`] = r.problem;
        else inner.push(r.condition);
      });
      if (inner.length) out.push(item.join === 'all' ? { all: inner } : { any: inner });
      return;
    }
    count++;
    const r = conditionToWire(spec, item);
    if ('problem' in r) problems.byCondition[String(i)] = r.problem;
    else out.push(r.condition);
  });
  if (count > MAX_CONDITIONS) problems.general.push(`Use at most ${MAX_CONDITIONS} conditions.`);
  const filter = out.length ? (d.join === 'all' ? { all: out } : { any: out }) : undefined;
  return { filter, problems };
}

/**
 * The BFF's 400 `invalid_params` message ("Invalid parameters: adv: createdDateTime ge: expects …; userType: …") →
 * the messages for each param.
 */
export function paramIssues(message: string, names: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const body = message.replace(/^Invalid parameters:\s*/, '');
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escaped.length) return out;
  const re = new RegExp(`(?:^|;\\s)(${escaped.join('|')}): `, 'g');
  const starts = [...body.matchAll(re)];
  starts.forEach((m, k) => {
    const from = m.index! + m[0].length;
    const to = k + 1 < starts.length ? starts[k + 1]!.index! : body.length;
    (out[m[1]!] ??= []).push(body.slice(from, to).trim());
  });
  return out;
}

/** Server messages that name a condition ("createdDateTime ge: expects …") → that condition's key; the rest are general. */
export function placeServerIssues(
  d: Draft,
  issues: readonly string[],
): { byCondition: Record<string, string>; general: string[] } {
  const byCondition: Record<string, string> = {};
  const general: string[] = [];
  const keys: Array<[string, DraftCondition]> = [];
  d.items.forEach((it, i) =>
    it.kind === 'group'
      ? it.items.forEach((c, j) => keys.push([`${i}.${j}`, c]))
      : keys.push([String(i), it]),
  );
  for (const m of issues) {
    const hit = keys.find(([k, c]) => !byCondition[k] && m.startsWith(`${c.field} ${c.op}: `));
    if (hit)
      byCondition[hit[0]] = m
        .slice(`${hit[1].field} ${hit[1].op}: `.length)
        .replace(/^./, (x) => x.toUpperCase());
    else general.push(m);
  }
  return { byCondition, general };
}

// ── UI ──────────────────────────────────────────────────────────────────────────────────────────────

function JoinSelect({
  value,
  onChange,
  label,
}: {
  value: 'all' | 'any';
  onChange: (v: 'all' | 'any') => void;
  label: string;
}) {
  return (
    <Select
      aria-label={label}
      className="w-28"
      triggerClassName="h-7"
      value={value}
      onValueChange={(v) => onChange(v as 'all' | 'any')}
      options={[
        { value: 'all', label: 'all' },
        { value: 'any', label: 'any' },
      ]}
    />
  );
}

function ConditionRow({
  spec,
  c,
  label,
  problem,
  onChange,
  onRemove,
}: {
  spec: AdvancedSpec;
  c: DraftCondition;
  label: string;
  problem?: string;
  onChange: (next: DraftCondition) => void;
  onRemove: () => void;
}) {
  const f = fieldOf(spec, c.field) ?? spec.fields[0]!;
  const problemId = useId();
  const set = (patch: Partial<DraftCondition>) => {
    const next = { ...c, ...patch };
    const nf = fieldOf(spec, next.field) ?? f;
    if (!opsOf(nf).includes(next.op)) next.op = opsOf(nf)[0]!;
    if (patch.field && patch.field !== c.field) {
      next.text = '';
      next.picks = [];
    }
    onChange(next);
  };
  const describedBy = problem ? problemId : undefined;
  let value;
  if (c.op === 'isEmpty')
    value = <span className="flex h-(--af-control-h) flex-1 items-center text-sm text-fg-3">no value</span>;
  else if ((f.type === 'enum' || f.type === 'boolean') && c.op === 'in')
    value = (
      <div
        role="group"
        aria-label={`${label} values`}
        className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1 py-1"
      >
        {(f.type === 'boolean' ? ['true', 'false'] : (f.values ?? []).map(String)).map((v) => (
          <Checkbox
            key={v}
            label={f.type === 'boolean' ? (v === 'true' ? 'Yes' : 'No') : v}
            checked={c.picks.includes(v)}
            onCheckedChange={(on) => set({ picks: on ? [...c.picks, v] : c.picks.filter((x) => x !== v) })}
          />
        ))}
      </div>
    );
  else if (f.type === 'enum' || f.type === 'boolean')
    value = (
      <Select
        aria-label={`${label} value`}
        className="min-w-0 flex-1"
        value={c.picks[0]}
        placeholder="Choose…"
        onValueChange={(v) => set({ picks: [v] })}
        options={
          f.type === 'boolean'
            ? [
                { value: 'true', label: 'Yes' },
                { value: 'false', label: 'No' },
              ]
            : (f.values ?? []).map((v) => ({ value: String(v), label: String(v) }))
        }
      />
    );
  else
    value = (
      <TextField
        aria-label={`${label} value`}
        aria-describedby={describedBy}
        aria-invalid={problem ? true : undefined}
        className="min-w-0 flex-1"
        type={f.type === 'number' && c.op !== 'in' ? 'number' : 'text'}
        maxLength={c.op === 'in' ? undefined : MAX_STRING}
        placeholder={
          c.op === 'in'
            ? 'value, value, …'
            : f.type === 'date'
              ? '2026-01-31, today or -30d'
              : f.type === 'guid'
                ? '00000000-0000-0000-0000-000000000000'
                : ''
        }
        value={c.text}
        onChange={(e) => set({ text: e.target.value })}
      />
    );
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <Select
          aria-label={`${label} field`}
          className="w-44"
          value={c.field}
          onValueChange={(v) => set({ field: v })}
          options={spec.fields.map((x) => ({ value: x.field, label: x.label }))}
        />
        <Select
          aria-label={`${label} operator`}
          className="w-48"
          value={c.op}
          onValueChange={(v) => set({ op: v as AdvancedOp })}
          options={opsOf(f).map((o) => ({ value: o, label: OP_LABEL[o] }))}
        />
        {value}
        <IconButton
          label={`Remove ${label.toLowerCase()}`}
          icon={<TrashIcon size={14} />}
          size="sm"
          tooltip={false}
          onClick={onRemove}
          className="mt-0.5"
        />
      </div>
      {problem && (
        <p id={problemId} className="flex items-center gap-1 pl-1 text-xs text-crit">
          <WarningIcon size={12} weight="fill" aria-hidden />
          {problem}
        </p>
      )}
    </li>
  );
}

export interface QueryBuilderProps {
  spec: AdvancedSpec;
  filter: WireGroup | undefined;
  onApply: (filter: WireGroup | undefined) => void;
  /** What the BFF rejected (400 invalid_params), shown in the builder. */
  serverIssues?: string[];
}

export function QueryBuilder({ spec, filter, onApply, serverIssues = [] }: QueryBuilderProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFromWire(spec, filter));
  const [problems, setProblems] = useState<DraftProblems>({ byCondition: {}, general: [] });
  const s = filterBar();
  const count = countConditions(filter);
  // What the service rejected, next to the condition it names (until the user applies again).
  const fromServer = placeServerIssues(draft, serverIssues);
  const problemFor = (key: string) => problems.byCondition[key] ?? fromServer.byCondition[key];
  const total = draft.items.reduce((n, it) => n + (it.kind === 'group' ? it.items.length : 1), 0);
  const full = total >= MAX_CONDITIONS;

  const setItem = (i: number, next: DraftCondition | DraftGroup) =>
    setDraft((d) => ({ ...d, items: d.items.map((x, k) => (k === i ? next : x)) }));
  const removeItem = (i: number) => setDraft((d) => ({ ...d, items: d.items.filter((_, k) => k !== i) }));
  const apply = () => {
    const r = draftToWire(spec, draft);
    setProblems(r.problems);
    if (Object.keys(r.problems.byCondition).length || r.problems.general.length) return;
    onApply(r.filter);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setDraft(draftFromWire(spec, filter));
          setProblems({ byCondition: {}, general: [] });
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="sm"
          intent={count ? 'secondary' : 'ghost'}
          className={cn(count ? 'border-accent' : 'border-line', serverIssues.length > 0 && 'border-crit')}
          aria-label={
            count
              ? `Advanced filter, ${count} ${count === 1 ? 'condition' : 'conditions'}`
              : 'Advanced filter'
          }
        >
          <FunnelSimpleIcon size={13} aria-hidden className="text-fg-3" />
          Advanced
          {count > 0 && (
            <span className={s.facetCount()} aria-hidden>
              {count}
            </span>
          )}
          <CaretDownIcon size={12} weight="bold" aria-hidden className="text-fg-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-180 max-w-(--radix-popover-content-available-width) p-3"
        aria-label="Advanced filter"
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
          noValidate
        >
          {serverIssues.length > 0 && (
            <div
              role="alert"
              className="rounded-md border border-crit bg-crit-subtle px-3 py-2 text-sm text-fg"
            >
              <p className="font-semibold">The service rejected this filter</p>
              <ul className="mt-1 list-disc pl-5 text-fg-2">
                {serverIssues.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex items-center gap-2 text-sm text-fg-2">
            Rows match
            <JoinSelect
              label="Match all or any conditions"
              value={draft.join}
              onChange={(join) => setDraft((d) => ({ ...d, join }))}
            />
            of these conditions
          </div>
          <ol className="flex flex-col gap-2" aria-label="Conditions">
            {draft.items.map((item, i) =>
              item.kind === 'group' ? (
                <li key={i} className="rounded-md border border-line bg-sunken p-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm text-fg-2">
                      Group: match
                      <JoinSelect
                        label={`Group ${i + 1}: match all or any`}
                        value={item.join}
                        onChange={(join) => setItem(i, { ...item, join })}
                      />
                      of
                    </div>
                    <Button size="sm" intent="ghost" onClick={() => removeItem(i)}>
                      Remove group
                    </Button>
                  </div>
                  <ol className="flex flex-col gap-2" aria-label={`Group ${i + 1} conditions`}>
                    {item.items.map((c, j) => (
                      <ConditionRow
                        key={j}
                        spec={spec}
                        c={c}
                        label={`Group ${i + 1} condition ${j + 1}`}
                        problem={problemFor(`${i}.${j}`)}
                        onChange={(next) =>
                          setItem(i, { ...item, items: item.items.map((x, k) => (k === j ? next : x)) })
                        }
                        onRemove={() => setItem(i, { ...item, items: item.items.filter((_, k) => k !== j) })}
                      />
                    ))}
                  </ol>
                  <Button
                    size="sm"
                    intent="ghost"
                    className="mt-2"
                    disabled={full}
                    onClick={() => setItem(i, { ...item, items: [...item.items, blankCondition(spec)] })}
                  >
                    <PlusIcon size={13} aria-hidden />
                    Add condition to group
                  </Button>
                </li>
              ) : (
                <ConditionRow
                  key={i}
                  spec={spec}
                  c={item}
                  label={`Condition ${i + 1}`}
                  problem={problemFor(String(i))}
                  onChange={(next) => setItem(i, next)}
                  onRemove={() => removeItem(i)}
                />
              ),
            )}
          </ol>
          {problems.general.map((m) => (
            <p key={m} role="alert" className="text-xs text-crit">
              {m}
            </p>
          ))}
          <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
            <div className="flex gap-1">
              <Button
                size="sm"
                intent="ghost"
                disabled={full}
                onClick={() => setDraft((d) => ({ ...d, items: [...d.items, blankCondition(spec)] }))}
              >
                <PlusIcon size={13} aria-hidden />
                Add condition
              </Button>
              <Button
                size="sm"
                intent="ghost"
                disabled={full}
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    items: [
                      ...d.items,
                      {
                        kind: 'group',
                        join: d.join === 'all' ? 'any' : 'all',
                        items: [blankCondition(spec)],
                      },
                    ],
                  }))
                }
              >
                <PlusIcon size={13} aria-hidden />
                Add group
              </Button>
            </div>
            <div className="flex gap-2">
              {count > 0 && (
                <Button
                  size="sm"
                  intent="ghost"
                  onClick={() => {
                    onApply(undefined);
                    setOpen(false);
                  }}
                >
                  Clear advanced filter
                </Button>
              )}
              <Button size="sm" intent="primary" type="submit">
                Apply
              </Button>
            </div>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
