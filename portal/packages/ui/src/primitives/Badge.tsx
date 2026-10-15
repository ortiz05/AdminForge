import type { ComponentProps } from 'react';
import type { VariantProps } from 'tailwind-variants';
import { badge } from '../recipes/badge';

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badge>;

/** A small, static label: "Default", "Initial", "Preview", counts. Status uses StatusPill instead. */
export function Badge({ tone, mono, className, ...rest }: BadgeProps) {
  return <span {...rest} className={badge({ tone, mono, className })} />;
}
