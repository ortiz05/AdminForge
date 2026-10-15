import type { ComponentProps, ReactNode } from 'react';
import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { Command as C } from 'cmdk';
import { Dialog as D } from 'radix-ui';
import { floatingItem, scrim } from '../recipes/overlay';
import { cn } from '../recipes/tv';
import { useReturnFocus } from '../lib/return-focus';
import { Kbd } from './Kbd';
import { commandPalette } from '../recipes/command';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placeholder?: string;
  /** Accessible name of the palette. */
  label?: string;
  search?: string;
  onSearchChange?: (value: string) => void;
  children: ReactNode;
  footer?: ReactNode;
}

/** Ctrl/⌘K palette shell (cmdk inside a Radix dialog). Compose with CommandGroup / CommandItem. */
export function CommandPalette({
  open,
  onOpenChange,
  placeholder = 'Search…',
  label = 'Command palette',
  search,
  onSearchChange,
  children,
  footer,
}: CommandPaletteProps) {
  const s = commandPalette();
  const focus = useReturnFocus();
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={scrim({ className: 'z-(--af-z-palette) items-start' })}>
          <D.Content className={s.content()} aria-describedby={undefined} {...focus}>
            <D.Title className="sr-only">{label}</D.Title>
            <C label={label} loop className="flex min-h-0 flex-col">
              <div className={s.inputRow()}>
                <MagnifyingGlassIcon size={18} aria-hidden />
                <C.Input
                  value={search}
                  onValueChange={onSearchChange}
                  placeholder={placeholder}
                  className={s.input()}
                />
                <Kbd keys="Esc" />
              </div>
              <C.List className={s.list()}>
                <C.Empty className={s.empty()}>
                  No matches. Try a page name, or an action like “theme”.
                </C.Empty>
                {children}
              </C.List>
              {footer && <div className={s.footer()}>{footer}</div>}
            </C>
          </D.Content>
        </D.Overlay>
      </D.Portal>
    </D.Root>
  );
}

export function CommandGroup({
  heading,
  children,
  className,
}: {
  heading: string;
  children: ReactNode;
  className?: string;
}) {
  const s = commandPalette();
  return (
    <C.Group heading={<span className={s.heading()}>{heading}</span>} className={cn('pb-1', className)}>
      {children}
    </C.Group>
  );
}

export function CommandItem({
  icon,
  hint,
  shortcut,
  className,
  children,
  ...rest
}: ComponentProps<typeof C.Item> & { icon?: ReactNode; hint?: ReactNode; shortcut?: string[] }) {
  return (
    <C.Item {...rest} className={floatingItem({ className: cn('min-h-9', className) })}>
      {icon && <span className="flex shrink-0 text-fg-3">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 truncate text-xs text-fg-3">{hint}</span>}
      {shortcut && <Kbd keys={shortcut} />}
    </C.Item>
  );
}

export function CommandSeparator() {
  return <C.Separator className="-mx-1.5 my-1 h-px bg-line" />;
}
