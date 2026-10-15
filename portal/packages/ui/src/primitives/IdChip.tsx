import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { shorten } from '../lib/format';
import { useCopy } from '../lib/hooks';
import { idChip } from '../recipes/id-chip';

export interface IdChipProps {
  value: string;
  /** What the value is ("Tenant ID", "Object ID"); used in the copy button's name. */
  label?: string;
  /** Show the label inside the chip (default) or only use it for the accessible name. */
  showLabel?: boolean;
  /** Show the whole value instead of head…tail. */
  full?: boolean;
  className?: string;
}

/** A GUID or resource id: `3f2a…9c1d` with the full value on hover and a copy button. */
export function IdChip({ value, label, showLabel = true, full, className }: IdChipProps) {
  const [copied, copy] = useCopy();
  const s = idChip({ copied });
  const name = label ?? 'value';
  return (
    <span className={s.root({ className })}>
      {label && showLabel && <span className={s.label()}>{label}</span>}
      <code className={s.value()} title={value}>
        {full ? value : shorten(value)}
      </code>
      <button
        type="button"
        className={s.copy()}
        aria-label={`Copy ${name} ${value}`}
        onClick={() => void copy(value)}
      >
        {copied ? <CheckIcon size={13} weight="bold" aria-hidden /> : <CopyIcon size={13} aria-hidden />}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? `${label ?? 'Value'} copied` : ''}
      </span>
    </span>
  );
}
