import type { ReactNode } from 'react';
import type { VariantProps } from 'tailwind-variants';
import { STATUS_ICON, type StatusTone } from '../lib/status';
import { statusPill } from '../recipes/status-pill';

export type StatusPillProps = VariantProps<typeof statusPill> & {
  status: StatusTone;
  children: ReactNode;
  className?: string;
};

/** State as icon + label on a subtle fill. Never colour alone. */
export function StatusPill({ status, size, children, className }: StatusPillProps) {
  const s = statusPill({ status, size });
  const Glyph = STATUS_ICON[status];
  return (
    <span className={s.root({ className })} data-status={status}>
      <Glyph size={size === 'sm' ? 12 : 14} weight="fill" aria-hidden className={s.icon()} />
      <span className={s.label()}>{children}</span>
    </span>
  );
}
