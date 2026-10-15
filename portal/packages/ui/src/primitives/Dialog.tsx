import type { ReactNode } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { Dialog as D } from 'radix-ui';
import { dialog, scrim } from '../recipes/overlay';
import { useReturnFocus } from '../lib/return-focus';
import { IconButton } from './IconButton';

export interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Element that opens the dialog (rendered as the Radix trigger). */
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right-aligned. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Hide the close button (e.g. while a request is in flight). */
  hideClose?: boolean;
  className?: string;
}

/** Modal dialog: focus is trapped inside and restored to the trigger on close. Escape closes. */
export function Dialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
  size,
  hideClose,
  className,
}: DialogProps) {
  const s = dialog({ size });
  const focus = useReturnFocus();
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <D.Trigger asChild>{trigger}</D.Trigger>}
      <D.Portal>
        <D.Overlay className={scrim()}>
          <D.Content className={s.content({ className })} {...focus}>
            <div className={s.header()}>
              <div className="min-w-0">
                <D.Title className={s.title()}>{title}</D.Title>
                {description ? (
                  <D.Description className={s.description()}>{description}</D.Description>
                ) : (
                  <D.Description className="sr-only">
                    {typeof title === 'string' ? title : 'Dialog'}
                  </D.Description>
                )}
              </div>
              {!hideClose && (
                <D.Close asChild>
                  <IconButton
                    label="Close"
                    icon={<XIcon size={16} />}
                    size="sm"
                    tooltip={false}
                    className="-mt-0.5 -mr-2"
                  />
                </D.Close>
              )}
            </div>
            {children != null && <div className={s.body()}>{children}</div>}
            {footer && <div className={s.footer()}>{footer}</div>}
          </D.Content>
        </D.Overlay>
      </D.Portal>
    </D.Root>
  );
}

/** Closes the surrounding Dialog when clicked (wrap a Button). */
export const DialogClose = D.Close;
