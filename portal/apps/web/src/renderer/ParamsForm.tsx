import { useState } from 'react';
import type { Param, Params } from '@adminforge/schemas';
import { Panel, Select, Switch, TextField } from '@adminforge/ui';
import { DATE_RANGE_PRESETS, dateRangeLabel, enumOptions } from './params';

const labelOf = (name: string, p: Param) => p.label ?? name;

/** A text-like control that applies on blur or Enter (not per keystroke: each change re-runs the report). */
function DeferredText({ name, p, value, onChange, type = 'text' }: { name: string; p: Param; value: unknown; onChange: (v: unknown) => void; type?: string }) {
  const current = value == null ? '' : String(value);
  const [draft, setDraft] = useState(current);
  const [syncedFrom, setSyncedFrom] = useState(current);
  if (syncedFrom !== current) {
    setSyncedFrom(current);
    setDraft(current);
  }
  const commit = () => {
    if (draft === current) return;
    if (p.type === 'number') onChange(draft.trim() === '' ? undefined : Number(draft));
    else onChange(draft.trim() || undefined);
  };
  return (
    <TextField
      label={labelOf(name, p)}
      hint={p.description}
      type={type}
      placeholder={p.placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      className="w-56"
    />
  );
}

function Control({ name, p, value, onChange }: { name: string; p: Param; value: unknown; onChange: (v: unknown) => void }) {
  const label = labelOf(name, p);
  switch (p.type) {
    case 'enum': {
      const opts = enumOptions(p);
      return (
        <Select
          label={label}
          hint={p.description}
          className="w-56"
          value={value === undefined ? undefined : String(value)}
          onValueChange={(v) => onChange(opts.find((o) => String(o.value) === v)?.value ?? v)}
          options={opts.map((o) => ({ value: String(o.value), label: o.label }))}
        />
      );
    }
    case 'boolean':
      return (
        <div className="flex h-full min-h-14 items-end pb-1.5">
          <Switch label={label} description={p.description} checked={value === true} onCheckedChange={(on) => onChange(on)} />
        </div>
      );
    case 'dateRange': {
      const presets = p.presets?.length ? p.presets : ['P1D', 'P7D', 'P30D', 'P90D'];
      const current = typeof value === 'string' ? value : undefined;
      return (
        <Select
          label={label}
          hint={p.description}
          className="w-56"
          value={current}
          placeholder={dateRangeLabel(value)}
          onValueChange={(v) => onChange(v)}
          options={presets.map((d) => ({ value: d, label: DATE_RANGE_PRESETS[d] ?? d }))}
        />
      );
    }
    case 'number':
      return <DeferredText name={name} p={p} value={value} onChange={onChange} type="number" />;
    case 'date':
      return <DeferredText name={name} p={p} value={typeof value === 'string' ? value.slice(0, 10) : value} onChange={onChange} type="date" />;
    default:
      return <DeferredText name={name} p={p} value={value} onChange={onChange} />;
  }
}

/** Report parameters (§6.6 report template): every visible param as a form control; changes re-run the report. */
export function ParamsForm({
  declared,
  values,
  issues,
  onChange,
}: {
  declared: Params;
  values: Record<string, unknown>;
  issues: Record<string, string>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const visible = Object.entries(declared).filter(([, p]) => !p.hidden);
  if (!visible.length) return null;
  return (
    <Panel aria-label="Report parameters">
      <p className="af-eyebrow mb-3">Parameters</p>
      <form className="flex flex-wrap items-start gap-x-6 gap-y-4" onSubmit={(e) => e.preventDefault()} aria-label="Report parameters">
        {visible.map(([name, p]) => (
          <div key={name} className="flex flex-col gap-1">
            <Control name={name} p={p} value={values[name]} onChange={(v) => onChange({ [name]: v })} />
            {issues[name] && <span className="text-xs text-warn">{issues[name]} — using the default.</span>}
          </div>
        ))}
      </form>
    </Panel>
  );
}
