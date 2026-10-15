import { useId, type ComponentProps, type ReactNode } from 'react';
import { WarningCircleIcon } from '@phosphor-icons/react';
import { control, field } from '../recipes/field';
import { cn } from '../recipes/tv';

export interface FieldShellProps {
  label?: ReactNode;
  /** Visually hidden label (search boxes, compact toolbars). */
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  className?: string;
}

interface ShellRenderProps {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

/** Label, hint and error wiring for any control. */
export function FieldShell({
  label,
  hideLabel,
  hint,
  error,
  optional,
  className,
  id: givenId,
  children,
}: FieldShellProps & { id?: string; children: (p: ShellRenderProps) => ReactNode }) {
  const autoId = useId();
  const id = givenId ?? autoId;
  const s = field();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={s.root({ className })}>
      {label && (
        <label htmlFor={id} className={cn(s.label(), hideLabel && 'sr-only')}>
          {label}
          {optional && (
            <>
              {' '}
              <span className={s.optional()}>(optional)</span>
            </>
          )}
        </label>
      )}
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error && (
        <p id={errorId} className={s.error()}>
          <WarningCircleIcon size={14} weight="fill" aria-hidden />
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className={s.hint()}>
          {hint}
        </p>
      )}
    </div>
  );
}

export type TextFieldProps = Omit<ComponentProps<'input'>, 'size'> &
  FieldShellProps & {
    /** Icon or text inside the left edge. */
    leading?: ReactNode;
    /** Content inside the right edge (a clear button, a Kbd hint). */
    trailing?: ReactNode;
    inputClassName?: string;
  };

export function TextField({
  label,
  hideLabel,
  hint,
  error,
  optional,
  className,
  leading,
  trailing,
  inputClassName,
  id,
  ...rest
}: TextFieldProps) {
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
      {({ id: inputId, describedBy, invalid }) => (
        <div className="relative flex items-center">
          {leading && <span className="pointer-events-none absolute left-2.5 flex text-fg-3">{leading}</span>}
          <input
            id={inputId}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            {...rest}
            className={control({
              kind: 'input',
              className: cn(leading && 'pl-8', trailing && 'pr-9', inputClassName),
            })}
          />
          {trailing && <span className="absolute right-1.5 flex items-center">{trailing}</span>}
        </div>
      )}
    </FieldShell>
  );
}

export type TextareaProps = ComponentProps<'textarea'> & FieldShellProps & { textareaClassName?: string };

export function Textarea({
  label,
  hideLabel,
  hint,
  error,
  optional,
  className,
  textareaClassName,
  id,
  ...rest
}: TextareaProps) {
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
      {({ id: inputId, describedBy, invalid }) => (
        <textarea
          id={inputId}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          {...rest}
          className={control({ kind: 'textarea', className: textareaClassName })}
        />
      )}
    </FieldShell>
  );
}
