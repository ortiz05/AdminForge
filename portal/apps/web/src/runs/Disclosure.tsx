import { useId, useState, type ReactNode } from 'react';
import { CaretRightIcon, cn } from '@adminforge/ui';

/** "Show output" style toggle: a caret button that reveals a region below it. */
export function Disclosure({
  label,
  openLabel,
  children,
  defaultOpen = false,
  className,
}: {
  label: string;
  openLabel?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-accent hover:underline"
      >
        <CaretRightIcon
          size={11}
          weight="bold"
          aria-hidden
          className={cn(
            'transition-transform duration-(--af-motion-fast) motion-reduce:transition-none',
            open && 'rotate-90',
          )}
        />
        {open ? (openLabel ?? label) : label}
      </button>
      {open && (
        <div id={id} className="mt-2">
          {children}
        </div>
      )}
    </div>
  );
}
