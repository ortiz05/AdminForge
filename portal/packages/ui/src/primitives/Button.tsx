import { useId, type ComponentProps, type MouseEvent } from 'react';
import { CircleNotchIcon, LockSimpleIcon } from '@phosphor-icons/react';
import { button, type ButtonVariants } from '../recipes/button';

export type ButtonProps = ComponentProps<'button'> &
  ButtonVariants & {
    /** When set, the button stays focusable but inert, shows a lock, and this text is announced as its description. */
    locked?: string;
    /** Work in progress: the button ignores clicks and shows a spinner. */
    pending?: boolean;
  };

export function Button({
  intent,
  size,
  locked,
  pending,
  className,
  onClick,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const descId = useId();
  const inert = Boolean(locked) || pending;
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (inert) return e.preventDefault();
    onClick?.(e);
  };
  return (
    <button
      type={type}
      {...rest}
      aria-disabled={inert ? true : rest['aria-disabled']}
      aria-busy={pending || undefined}
      aria-describedby={
        locked ? [descId, rest['aria-describedby']].filter(Boolean).join(' ') : rest['aria-describedby']
      }
      className={button({ intent, size, className })}
      onClick={handleClick}
    >
      {locked && size !== 'icon' && size !== 'icon-sm' && (
        <LockSimpleIcon size={14} weight="bold" aria-hidden className="shrink-0" />
      )}
      {pending && <CircleNotchIcon size={14} weight="bold" aria-hidden className="shrink-0 animate-spin" />}
      {children}
      {/* `hidden`: excluded from the button's name, still used as its description (aria-describedby reads hidden nodes). */}
      {locked && (
        <span id={descId} hidden>
          {locked}
        </span>
      )}
    </button>
  );
}
