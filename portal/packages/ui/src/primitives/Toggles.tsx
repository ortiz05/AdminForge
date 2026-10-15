import { useId, type MouseEventHandler, type ReactNode } from 'react';
import { CheckIcon, MinusIcon } from '@phosphor-icons/react';
import { Checkbox as C, Switch as Sw, ToggleGroup } from 'radix-ui';
import { cn } from '../recipes/tv';
import { segmented, toggle } from '../recipes/toggles';

interface ToggleBase {
  /** Visible label; omit only with `aria-label`. */
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  'aria-label'?: string;
}

export type CheckboxProps = ToggleBase & {
  checked?: boolean | 'indeterminate';
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  onClick?: MouseEventHandler<HTMLButtonElement>;
};

export function Checkbox({
  label,
  description,
  checked,
  defaultChecked,
  onCheckedChange,
  onClick,
  disabled,
  id,
  name,
  className,
  ...aria
}: CheckboxProps) {
  const autoId = useId();
  const cid = id ?? autoId;
  const s = toggle();
  const box = (
    <C.Root
      id={cid}
      name={name}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={(v) => onCheckedChange?.(v === true)}
      onClick={onClick}
      disabled={disabled}
      aria-label={aria['aria-label']}
      aria-describedby={description ? `${cid}-desc` : undefined}
      className={s.checkbox({ className: label ? undefined : className })}
    >
      <C.Indicator className="flex">
        {checked === 'indeterminate' ? (
          <MinusIcon size={12} weight="bold" aria-hidden />
        ) : (
          <CheckIcon size={12} weight="bold" aria-hidden />
        )}
      </C.Indicator>
    </C.Root>
  );
  if (!label) return box;
  return (
    <div className={s.row({ className })}>
      {box}
      <span className={s.text()}>
        <label htmlFor={cid} className={s.label()}>
          {label}
        </label>
        {description && (
          <span id={`${cid}-desc`} className={s.description()}>
            {description}
          </span>
        )}
      </span>
    </div>
  );
}

export type SwitchProps = ToggleBase & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

export function Switch({
  label,
  description,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  id,
  name,
  className,
  ...aria
}: SwitchProps) {
  const autoId = useId();
  const sid = id ?? autoId;
  const s = toggle();
  const control = (
    <Sw.Root
      id={sid}
      name={name}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={aria['aria-label']}
      aria-describedby={description ? `${sid}-desc` : undefined}
      className={s.switchRoot({ className: label ? undefined : className })}
    >
      <Sw.Thumb className={s.switchThumb()} />
    </Sw.Root>
  );
  if (!label) return control;
  return (
    <div className={s.row({ className: cn('items-center', className) })}>
      {control}
      <span className={s.text()}>
        <label htmlFor={sid} className={s.label()}>
          {label}
        </label>
        {description && (
          <span id={`${sid}-desc`} className={s.description()}>
            {description}
          </span>
        )}
      </span>
    </div>
  );
}

export interface SegmentOption {
  value: string;
  label: ReactNode;
  /** Accessible name when the label is an icon. */
  'aria-label'?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SegmentOption[];
  /** Names the group for assistive technology. */
  'aria-label': string;
  size?: 'sm' | 'md';
  className?: string;
}

/** One of a few mutually exclusive views (Chart | Table, Comfortable | Compact). Arrow keys move between options. */
export function SegmentedControl({
  value,
  onValueChange,
  options,
  size = 'md',
  className,
  ...aria
}: SegmentedControlProps) {
  const s = segmented({ size });
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onValueChange(v)}
      aria-label={aria['aria-label']}
      className={s.root({ className })}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          aria-label={o['aria-label']}
          className={s.item()}
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
