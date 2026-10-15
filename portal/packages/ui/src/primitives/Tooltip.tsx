import type { ReactElement, ReactNode } from 'react';
import { Tooltip as T } from 'radix-ui';
import { tooltip } from '../recipes/tooltip';

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  delay?: number;
  /** Render nothing extra (e.g. the label is already visible). */
  disabled?: boolean;
}

/** Supplementary text on hover and focus. Never the only place information lives. */
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  delay = 300,
  disabled,
}: TooltipProps) {
  if (disabled || content == null || content === '') return children;
  return (
    <T.Provider delayDuration={delay} skipDelayDuration={200}>
      <T.Root>
        <T.Trigger asChild>{children}</T.Trigger>
        <T.Portal>
          <T.Content side={side} align={align} sideOffset={6} collisionPadding={8} className={tooltip()}>
            {content}
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  );
}
