import type { ReactNode } from 'react';
import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react';
import { Select as S } from 'radix-ui';
import { control } from '../recipes/field';
import { floating, floatingItem } from '../recipes/overlay';
import { cn } from '../recipes/tv';
import { FieldShell, type FieldShellProps } from './Field';

export interface SelectOption {
  value: string;
  label: string;
  /** Second line of muted text. */
  description?: string;
  disabled?: boolean;
}

export type SelectProps = FieldShellProps & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  name?: string;
  id?: string;
  /** Accessible name when there is no visible label. */
  'aria-label'?: string;
  triggerClassName?: string;
  leading?: ReactNode;
};

/** Single choice from a short list. Keyboard: arrows, type-ahead, Enter/Space, Escape. */
export function Select({
  label,
  hideLabel,
  hint,
  error,
  optional,
  className,
  value,
  defaultValue,
  onValueChange,
  options,
  placeholder = 'Choose…',
  disabled,
  name,
  id,
  triggerClassName,
  leading,
  'aria-label': ariaLabel,
}: SelectProps) {
  return (
    <FieldShell
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      error={error}
      optional={optional}
      className={className}
      id={id}
    >
      {({ id: triggerId, describedBy, invalid }) => (
        <S.Root
          value={value}
          defaultValue={defaultValue}
          onValueChange={onValueChange}
          disabled={disabled}
          name={name}
        >
          <S.Trigger
            id={triggerId}
            aria-label={ariaLabel}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            className={control({ kind: 'select', className: triggerClassName })}
          >
            <span className="flex min-w-0 items-center gap-2 truncate">
              {leading}
              <S.Value placeholder={<span className="text-fg-3">{placeholder}</span>} />
            </span>
            <S.Icon className="shrink-0 text-fg-3">
              <CaretDownIcon size={14} weight="bold" aria-hidden />
            </S.Icon>
          </S.Trigger>
          <S.Portal>
            <S.Content
              position="popper"
              sideOffset={4}
              className={cn(
                floating(),
                'max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width)',
              )}
            >
              <S.Viewport>
                {options.map((o) => (
                  <S.Item
                    key={o.value}
                    value={o.value}
                    disabled={o.disabled}
                    className={floatingItem({ inset: true })}
                  >
                    <S.ItemIndicator className="absolute left-2 flex text-accent">
                      <CheckIcon size={14} weight="bold" aria-hidden />
                    </S.ItemIndicator>
                    <span className="flex min-w-0 flex-col">
                      <S.ItemText>{o.label}</S.ItemText>
                      {o.description && <span className="text-xs text-fg-3">{o.description}</span>}
                    </span>
                  </S.Item>
                ))}
              </S.Viewport>
            </S.Content>
          </S.Portal>
        </S.Root>
      )}
    </FieldShell>
  );
}
