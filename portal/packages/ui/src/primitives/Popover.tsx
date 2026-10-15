import type { ComponentProps } from 'react';
import { Popover as P } from 'radix-ui';
import { floating } from '../recipes/overlay';
import { cn } from '../recipes/tv';

/** Non-modal floating panel anchored to a trigger (filters, pickers). */
export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

export function PopoverContent({
  className,
  sideOffset = 6,
  align = 'start',
  ...rest
}: ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        {...rest}
        className={cn(floating(), 'p-0', className)}
      />
    </P.Portal>
  );
}
