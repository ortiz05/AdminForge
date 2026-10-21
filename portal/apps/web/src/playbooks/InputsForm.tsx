import { isEntityParam, isInputRequired, type Param, type Params } from '@adminforge/schemas';
import { Checkbox, FieldShell, Select, Switch, Textarea, TextField } from '@adminforge/ui';
import { EntityPicker } from './EntityPicker';
import { labelOf, visibleInputs, type FormValues } from './form';

const asString = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const optionValue = (o: unknown) =>
  o && typeof o === 'object' && 'value' in o ? (o as { value: unknown }).value : o;
const optionLabel = (o: unknown) =>
  o && typeof o === 'object' && 'label' in o
    ? String((o as { label: unknown }).label)
    : String(optionValue(o));

const FORMAT_HINT: Record<string, string> = {
  guid: 'An object id (GUID).',
  email: 'An email address.',
  upn: 'A user principal name, e.g. name@example.com.',
  url: 'An http(s) URL.',
  hostname: 'A host name, e.g. portal.example.com.',
};

function InputField({
  name,
  param: p,
  value,
  error,
  onChange,
}: {
  name: string;
  param: Param;
  value: unknown;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const label = labelOf(name, p);
  const optional = !isInputRequired(p);
  const common = { label, error, optional, placeholder: p.placeholder };

  if (isEntityParam(p) || (p.type === 'string' && p.picker)) {
    const kind = p.type === 'string' ? p.picker! : p.type;
    return (
      <EntityPicker
        kind={kind}
        label={label}
        value={value as string | string[] | undefined}
        onChange={onChange}
        multiple={isEntityParam(p) ? p.multiple : false}
        maxItems={isEntityParam(p) ? p.maxItems : undefined}
        hint={p.description}
        error={error}
        optional={optional}
        placeholder={p.placeholder}
      />
    );
  }

  switch (p.type) {
    case 'string':
      return p.multiline ? (
        <Textarea
          {...common}
          hint={
            p.description ??
            (p.minLength ? `At least ${p.minLength} characters. Recorded in the audit log.` : undefined)
          }
          value={asString(value)}
          maxLength={p.maxLength}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <TextField
          {...common}
          hint={p.description ?? (p.format ? FORMAT_HINT[p.format] : undefined)}
          value={asString(value)}
          maxLength={p.maxLength}
          spellCheck={p.format ? false : undefined}
          inputClassName={p.format === 'guid' ? 'font-mono' : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'guid':
      return (
        <TextField
          {...common}
          hint={p.description ?? FORMAT_HINT.guid}
          value={asString(value)}
          spellCheck={false}
          inputClassName="font-mono"
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'number':
      return (
        <TextField
          {...common}
          type="number"
          inputMode={p.integer ? 'numeric' : 'decimal'}
          hint={
            p.description ??
            ([p.min !== undefined ? `min ${p.min}` : null, p.max !== undefined ? `max ${p.max}` : null]
              .filter(Boolean)
              .join(' · ') ||
              undefined)
          }
          min={p.min}
          max={p.max}
          step={p.step ?? (p.integer ? 1 : 'any')}
          value={asString(value)}
          trailing={p.unit ? <span className="pr-1.5 text-xs text-fg-3">{p.unit}</span> : undefined}
          inputClassName="tabular-nums"
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
      );
    case 'boolean':
      return (
        <Switch
          label={label}
          description={p.description}
          checked={value === true || value === 'true'}
          onCheckedChange={(on) => onChange(on)}
        />
      );
    case 'enum': {
      const opts = p.values.map((o) => ({ value: String(optionValue(o)), label: optionLabel(o) }));
      if (p.multiple) {
        const selected = Array.isArray(value) ? value.map(String) : [];
        return (
          <FieldShell label={label} hint={p.description} error={error} optional={optional}>
            {({ describedBy }) => (
              <div
                role="group"
                aria-label={label}
                aria-describedby={describedBy}
                className="flex flex-col gap-1.5"
              >
                {opts.map((o) => (
                  <Checkbox
                    key={o.value}
                    label={o.label}
                    checked={selected.includes(o.value)}
                    onCheckedChange={(on) =>
                      onChange(on ? [...selected, o.value] : selected.filter((x) => x !== o.value))
                    }
                  />
                ))}
              </div>
            )}
          </FieldShell>
        );
      }
      return (
        <Select
          {...common}
          hint={p.description}
          value={value === undefined ? undefined : String(value)}
          onValueChange={(v) => {
            const original = p.values.map(optionValue).find((x) => String(x) === v);
            onChange(original ?? v);
          }}
          options={opts}
        />
      );
    }
    case 'date':
      return (
        <TextField
          {...common}
          type={p.time ? 'datetime-local' : 'date'}
          hint={p.description}
          value={asString(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'dateRange': {
      const range = value && typeof value === 'object' ? (value as { from?: string; to?: string }) : {};
      const presets = p.presets ?? ['P1D', 'P7D', 'P30D'];
      const isPreset = typeof value === 'string';
      return (
        <FieldShell label={label} hint={p.description} error={error} optional={optional}>
          {() => (
            <div className="flex flex-col gap-2">
              <Select
                aria-label={`${label}: period`}
                value={isPreset ? (value as string) : 'custom'}
                onValueChange={(v) => onChange(v === 'custom' ? { from: '', to: '' } : v)}
                options={[
                  ...presets.map((d) => ({ value: d, label: `Last ${d.replace(/^PT?/, '').toLowerCase()}` })),
                  { value: 'custom', label: 'Custom range' },
                ]}
              />
              {!isPreset && (
                <div className="grid grid-cols-2 gap-2">
                  <TextField
                    label="From"
                    type="date"
                    value={range.from ?? ''}
                    onChange={(e) => onChange({ ...range, from: e.target.value })}
                  />
                  <TextField
                    label="To"
                    type="date"
                    value={range.to ?? ''}
                    onChange={(e) => onChange({ ...range, to: e.target.value })}
                  />
                </div>
              )}
            </div>
          )}
        </FieldShell>
      );
    }
    default:
      return null;
  }
}

/** The run form, generated from a definition's `inputs:` block. */
export function InputsForm({
  params,
  values,
  errors,
  onChange,
  omit = [],
  disabled,
  kind = 'playbook',
}: {
  params: Params;
  values: FormValues;
  errors: Record<string, string>;
  onChange: (name: string, value: unknown) => void;
  omit?: readonly string[];
  disabled?: boolean;
  kind?: 'playbook' | 'runbook';
}) {
  const fields = visibleInputs(params, omit);
  if (fields.length === 0) return <p className="text-sm text-fg-3">This {kind} takes no inputs.</p>;
  return (
    <fieldset className="flex flex-col gap-4" disabled={disabled}>
      {fields.map(([name, p]) => (
        <InputField
          key={name}
          name={name}
          param={p}
          value={values[name]}
          error={errors[name]}
          onChange={(v) => onChange(name, v)}
        />
      ))}
    </fieldset>
  );
}
