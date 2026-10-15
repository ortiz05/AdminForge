import { useRef } from 'react';

/**
 * Radix returns focus to its Trigger; overlays opened from code (the inspector, the palette, a dialog opened
 * from a menu) have none. Remember what had focus when the layer opened and go back to it on close.
 */
export function useReturnFocus() {
  const returnTo = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      returnTo.current =
        document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : null;
    },
    onCloseAutoFocus: (e: Event) => {
      const target = returnTo.current;
      returnTo.current = null;
      if (target?.isConnected) {
        e.preventDefault();
        target.focus();
      }
    },
  };
}
