import { useRef, type ReactNode } from 'react';
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
  /** Header actions next to Close (e.g. the inspector's "Open full page"), so they're reachable without scrolling. */
  actions?: ReactNode;
  /** `wide`: several times the standard width, never over the navigation rail — for detail that needs room. */
  size?: 'standard' | 'wide';
  /**
   * Non-modal only: the sheet covers the page beside it (too little left to use). A light scrim over the rest closes
   * the drawer on click; making the page itself inert is the caller's part (it knows which element that is).
   */
  cover?: boolean;
  /**
   * Where focus lands on open: the first control (default), or the sheet itself so Tab walks the header in order
   * (header actions → Close → body) — for drawers whose first control isn't the obvious start (the inspector).
   */
  initialFocus?: 'first' | 'container';
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
  actions,
  size = 'standard',
  cover = false,
  initialFocus = 'first',
  modal = true,
  docked,
  className,
}: DrawerProps) {
  const s = drawer({ docked, size });
  const focus = useReturnFocus();
  const sheet = useRef<HTMLDivElement>(null);
  const content = (
    <D.Content
      ref={sheet}
      className={s.content({ className })}
      {...focus}
      tabIndex={-1}
      onOpenAutoFocus={(e) => {
        focus.onOpenAutoFocus();
        if (initialFocus !== 'container') return;
        e.preventDefault();
        sheet.current?.focus();
      }}
      onInteractOutside={modal ? undefined : (e) => e.preventDefault()}
    >
      <div className={s.header()}>
        <div className="min-w-0">
          {eyebrow && <p className={s.eyebrow()}>{eyebrow}</p>}
          <D.Title className={s.title()} title={typeof title === 'string' ? title : undefined}>
            {title}
          </D.Title>
          {description ? (
            <D.Description className={s.description()}>{description}</D.Description>
          ) : (
            <D.Description className="sr-only">{typeof title === 'string' ? title : 'Details'}</D.Description>
          )}
        </div>
        <div className={s.actions()}>
          {actions}
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
      </div>
      <div className={s.body()}>{children}</div>
      {footer && <div className={s.footer()}>{footer}</div>}
    </D.Content>
  );
  return (
    <D.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <D.Portal>
        {modal ? <D.Overlay className={scrim({ className: 'block p-0' })} /> : null}
        {!modal && cover ? (
          <div
            className={s.cover()}
            aria-hidden="true"
            data-drawer-cover=""
            onClick={() => onOpenChange(false)}
          />
        ) : null}
        {content}
      </D.Portal>
    </D.Root>
  );
}
