import { useState } from 'react';
import type { FilterBar as FilterBarSpec } from '@adminforge/schemas';
import {
  Button,
  CaretDownIcon,
  FunnelSimpleIcon,
  IconButton,
  PlusIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  TextField,
  TrashIcon,
  filterBar,
} from '@adminforge/ui';

/**
 * The advanced filter (R9 query builder): conditions on the fields the page declares, compiled to OData `$filter`
 * or a KQL `where` clause in the browser with every value quoted/escaped, and written to the declared hidden param.
 * The structured conditions ride along in `<param>.rules` so the builder can be reopened and saved in views.
 */

type Advanced = NonNullable<FilterBarSpec['advanced']>;
type Field = Advanced['fields'][number];
export type Operator = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'startsWith' | 'contains' | 'in' | 'isEmpty';

export interface Rule {
  field: string;
  op: Operator;
  value: string;
}

const OP_LABEL: Record<Operator, string> = {
  eq: 'is',
  ne: 'is not',
  gt: 'after / greater than',
  ge: 'on or after / at least',
  lt: 'before / less than',
  le: 'on or before / at most',
  startsWith: 'starts with',
  contains: 'contains',
  in: 'is one of',
  isEmpty: 'is empty',
};

const DEFAULT_OPS: Record<Field['type'], Operator[]> = {
  string: ['eq', 'ne', 'startsWith'],
  number: ['eq', 'ne', 'gt', 'ge', 'lt', 'le'],
  boolean: ['eq'],
  date: ['ge', 'le'],
  guid: ['eq', 'ne'],
  enum: ['eq', 'ne', 'in'],
};

export const operatorsFor = (f: Field): Operator[] => (f.operators?.length ? (f.operators as Operator[]) : DEFAULT_OPS[f.type]);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELD = /^[A-Za-z_][A-Za-z0-9_/.]*$/;

/** One literal for a field type, or null when the value isn't valid for it (the rule is then skipped). */
function literal(dialect: 'odata' | 'kql', f: Field, raw: string): string | null {
  const v = raw.trim();
  switch (f.type) {
    case 'number':
      return v !== '' && Number.isFinite(Number(v)) ? String(Number(v)) : null;
    case 'boolean':
      return v === 'true' || v === 'false' ? v : null;
    case 'guid':
      return GUID.test(v) ? (dialect === 'odata' ? v : `'${v}'`) : null;
    case 'date': {
      const d = new Date(v);
      if (!v || Number.isNaN(d.getTime())) return null;
      return dialect === 'odata' ? d.toISOString() : `datetime(${d.toISOString()})`;
    }
    default:
      return dialect === 'odata' ? `'${v.replace(/'/g, "''")}'` : `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
}

/** Compiles rules into one filter expression (`and`-joined); invalid rules are dropped. */
export function compileRules(spec: Advanced, rules: readonly Rule[]): string {
  const dialect = spec.dialect === 'kql' ? 'kql' : 'odata';
  const parts: string[] = [];
  for (const r of rules) {
    const f = spec.fields.find((x) => x.field === r.field);
    if (!f || !FIELD.test(f.field) || !operatorsFor(f).includes(r.op)) continue;
    const name = f.field;
    if (r.op === 'isEmpty') {
      parts.push(dialect === 'odata' ? `${name} eq null` : `isempty(${name})`);
      continue;
    }
    if (r.op === 'in') {
      const values = r.value.split(',').map((x) => literal(dialect, f, x)).filter((x): x is string => x !== null);
      if (values.length) parts.push(`${name} in (${values.join(', ')})`);
      continue;
    }
    const lit = literal(dialect, f, r.value);
    if (lit === null) continue;
    if (dialect === 'odata') {
      if (r.op === 'startsWith') parts.push(`startswith(${name}, ${lit})`);
      else if (r.op === 'contains') parts.push(`contains(${name}, ${lit})`);
      else parts.push(`${name} ${r.op} ${lit}`);
    } else {
      const kql: Record<string, string> = { eq: '==', ne: '!=', gt: '>', ge: '>=', lt: '<', le: '<=', startsWith: 'startswith', contains: 'contains' };
      parts.push(`${name} ${kql[r.op]} ${lit}`);
    }
  }
  return parts.join(dialect === 'odata' ? ' and ' : ' and ');
}

export function readRules(raw: unknown): Rule[] {
  const list = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown; } catch { return []; } })() : raw;
  return Array.isArray(list)
    ? list.filter((r): r is Rule => !!r && typeof r === 'object' && typeof (r as Rule).field === 'string' && typeof (r as Rule).op === 'string').map((r) => ({ field: r.field, op: r.op, value: String(r.value ?? '') }))
    : [];
}

export function QueryBuilder({ spec, rules, onApply }: { spec: Advanced; rules: Rule[]; onApply: (rules: Rule[]) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Rule[]>(rules);
  const s = filterBar();
  const first = spec.fields[0]!;
  const blank = (): Rule => ({ field: first.field, op: operatorsFor(first)[0]!, value: '' });
  const set = (i: number, patch: Partial<Rule>) =>
    setDraft((d) =>
      d.map((r, j) => {
        if (j !== i) return r;
        const next = { ...r, ...patch };
        const f = spec.fields.find((x) => x.field === next.field)!;
        if (!operatorsFor(f).includes(next.op)) next.op = operatorsFor(f)[0]!;
        return next;
      }),
    );
  const apply = (next: Rule[]) => {
    onApply(next);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setDraft(rules.length ? rules : [blank()]);
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" intent={rules.length ? 'secondary' : 'ghost'} className={rules.length ? 'border-accent' : 'border-line'} aria-label={rules.length ? `Advanced filter, ${rules.length} conditions` : 'Advanced filter'}>
          <FunnelSimpleIcon size={13} aria-hidden className="text-fg-3" />
          Advanced
          {rules.length > 0 && (
            <span className={s.facetCount()} aria-hidden>
              {rules.length}
            </span>
          )}
          <CaretDownIcon size={12} weight="bold" aria-hidden className="text-fg-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-160 max-w-(--radix-popover-content-available-width) p-3" aria-label="Advanced filter">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            apply(draft.filter((r) => r.op === 'isEmpty' || r.value.trim() !== ''));
          }}
        >
          <p className="text-sm text-fg-2">Rows must match every condition. Values are sent to the service safely quoted.</p>
          <ol className="flex flex-col gap-2" aria-label="Conditions">
            {draft.map((r, i) => {
              const f = spec.fields.find((x) => x.field === r.field) ?? first;
              return (
                <li key={i} className="flex items-end gap-2">
                  <Select
                    label={i === 0 ? 'Field' : undefined}
                    aria-label={`Condition ${i + 1} field`}
                    className="w-44"
                    value={r.field}
                    onValueChange={(v) => set(i, { field: v, value: '' })}
                    options={spec.fields.map((x) => ({ value: x.field, label: x.label }))}
                  />
                  <Select
                    label={i === 0 ? 'Condition' : undefined}
                    aria-label={`Condition ${i + 1} operator`}
                    className="w-40"
                    value={r.op}
                    onValueChange={(v) => set(i, { op: v as Operator })}
                    options={operatorsFor(f).map((o) => ({ value: o, label: OP_LABEL[o] }))}
                  />
                  {r.op !== 'isEmpty' &&
                    (f.type === 'enum' && f.values?.length && r.op !== 'in' ? (
                      <Select
                        label={i === 0 ? 'Value' : undefined}
                        aria-label={`Condition ${i + 1} value`}
                        className="min-w-0 flex-1"
                        value={r.value || undefined}
                        onValueChange={(v) => set(i, { value: v })}
                        options={f.values.map((v) => ({ value: String(v), label: String(v) }))}
                      />
                    ) : f.type === 'boolean' ? (
                      <Select
                        label={i === 0 ? 'Value' : undefined}
                        aria-label={`Condition ${i + 1} value`}
                        className="min-w-0 flex-1"
                        value={r.value || undefined}
                        onValueChange={(v) => set(i, { value: v })}
                        options={[
                          { value: 'true', label: 'Yes' },
                          { value: 'false', label: 'No' },
                        ]}
                      />
                    ) : (
                      <TextField
                        label={i === 0 ? 'Value' : undefined}
                        aria-label={`Condition ${i + 1} value`}
                        className="min-w-0 flex-1"
                        type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                        placeholder={r.op === 'in' ? 'a, b, c' : f.type === 'guid' ? '00000000-0000-…' : ''}
                        value={r.value}
                        onChange={(e) => set(i, { value: e.target.value })}
                      />
                    ))}
                  <IconButton label={`Remove condition ${i + 1}`} icon={<TrashIcon size={14} />} size="sm" tooltip={false} onClick={() => setDraft((d) => d.filter((_, j) => j !== i))} />
                </li>
              );
            })}
          </ol>
          <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
            <Button size="sm" intent="ghost" onClick={() => setDraft((d) => [...d, blank()])}>
              <PlusIcon size={13} aria-hidden />
              Add condition
            </Button>
            <div className="flex gap-2">
              {rules.length > 0 && (
                <Button size="sm" intent="ghost" onClick={() => apply([])}>
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
