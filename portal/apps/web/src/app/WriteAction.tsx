import { Button, type ButtonProps } from '@adminforge/ui';
import { useShell } from './shell-context';

export const LOCKED_REASON = 'Arm write access to use this.';

/**
 * Any action that changes the tenant. In read mode it stays visible and focusable but locked, with a lock
 * glyph and the reason; once armed it works and carries a small ember dot.
 */
export function WriteAction({ children, ...props }: Omit<ButtonProps, 'locked'>) {
  const { arm } = useShell();
  return (
    <Button {...props} locked={arm.armed ? undefined : LOCKED_REASON}>
      {children}
      {arm.armed && <span className="af-armed-dot" aria-hidden />}
    </Button>
  );
}
