import { useState, type ReactNode } from 'react';
import { AlertDialog as A } from 'radix-ui';
import { dialog, scrim } from '../recipes/overlay';
import { useReturnFocus } from '../lib/return-focus';
import { Button } from './Button';
import { TextField } from './Field';

export interface ConfirmDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: string;
  description?: ReactNode;
  /** Exactly what happens: "Disable sign-in", "Delete 3 groups". */
  confirmLabel: string;
  cancelLabel?: string;
  intent?: 'primary' | 'danger' | 'armed';
  /**
   * Typed confirmation: the confirm button stays inert until this exact text is typed
   * ("Type j.doe@example.com to confirm").
   */
  confirmText?: string;
  /** May return a promise; the dialog shows progress and closes when it resolves. */
  onConfirm: () => void | Promise<void>;
  children?: ReactNode;
}

/** Confirmation for consequential actions. Focus starts on Cancel; typed mode guards irreversible ones. */
export function ConfirmDialog({
  open: openProp,
  onOpenChange,
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  intent = 'danger',
  confirmText,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const [openState, setOpenState] = useState(false);
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    if (!next) setTyped('');
    setOpenState(next);
    onOpenChange?.(next);
  };
  const matches = !confirmText || typed === confirmText;
  const s = dialog({ size: 'sm' });
  const focus = useReturnFocus();

  const confirm = async () => {
    if (!matches || pending) return;
    setPending(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <A.Root open={open} onOpenChange={setOpen}>
      {trigger && <A.Trigger asChild>{trigger}</A.Trigger>}
      <A.Portal>
        <A.Overlay className={scrim()}>
          <A.Content className={s.content()} {...focus}>
            <div className={s.header()}>
              <div className="min-w-0">
                <A.Title className={s.title()}>{title}</A.Title>
                <A.Description className={description ? s.description() : 'sr-only'}>
                  {description ?? title}
                </A.Description>
              </div>
            </div>
            {(children || confirmText) && (
              <div className={s.body()}>
                {children}
                {confirmText && (
                  <TextField
                    className="mt-2 mb-2"
                    label={
                      <>
                        Type <code className="rounded-sm bg-sunken px-1 py-0.5 text-fg">{confirmText}</code>{' '}
                        to confirm
                      </>
                    }
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    inputClassName="font-mono"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void confirm();
                    }}
                  />
                )}
              </div>
            )}
            <div className={s.footer()}>
              <A.Cancel asChild>
                <Button intent="ghost">{cancelLabel}</Button>
              </A.Cancel>
              <Button
                intent={intent}
                pending={pending}
                aria-disabled={!matches || undefined}
                onClick={(e) => {
                  e.preventDefault();
                  void confirm();
                }}
              >
                {confirmLabel}
              </Button>
            </div>
          </A.Content>
        </A.Overlay>
      </A.Portal>
    </A.Root>
  );
}
