import type { ReactNode } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { Dialog as D } from 'radix-ui';
import { scrim } from '../recipes/overlay';

import { useReturnFocus } from '../lib/return-focus';
import { IconButton } from './IconButton';
import { drawer } from '../recipes/drawer';

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Non-modal drawers leave the page usable (the inspector); modal ones trap focus. */
  modal?: boolean;
  docked?: boolean;
  className?: string;
}

/** A side sheet for detail without leaving the list. Escape closes; focus returns to what opened it. */
export function Drawer({
  open,
  onOpenChange,
  eyebrow,
  title,
  description,
  children,
  footer,
  modal = true,
  docked,
  className,
}: DrawerProps) {
  const s = drawer({ docked });
  const focus = useReturnFocus();
  const content = (
    <D.Content
      className={s.content({ className })}
      {...focus}
      onInteractOutside={modal ? undefined : (e) => e.preventDefault()}
    >
      <div className={s.header()}>
        <div className="min-w-0">
          {eyebrow && <p className={s.eyebrow()}>{eyebrow}</p>}
          <D.Title className={s.title()}>{title}</D.Title>
          {description ? (
            <D.Description className={s.description()}>{description}</D.Description>
          ) : (
            <D.Description className="sr-only">{typeof title === 'string' ? title : 'Details'}</D.Description>
          )}
        </div>
        <D.Close asChild>
          <IconButton
            label="Close"
            icon={<XIcon size={16} />}
            size="sm"
            tooltip={false}
            className="-mr-1.5"
          />
        </D.Close>
      </div>
      <div className={s.body()}>{children}</div>
      {footer && <div className={s.footer()}>{footer}</div>}
    </D.Content>
  );
  return (
    <D.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <D.Portal>
        {modal ? <D.Overlay className={scrim({ className: 'block p-0' })} /> : null}
        {content}
      </D.Portal>
    </D.Root>
  );
}
