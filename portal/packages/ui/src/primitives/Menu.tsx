import type { ComponentProps, ReactNode } from 'react';
import { CheckIcon, DotOutlineIcon } from '@phosphor-icons/react';
import { DropdownMenu as M } from 'radix-ui';
import { floating, floatingItem, floatingLabel, floatingSeparator } from '../recipes/overlay';
import { cn } from '../recipes/tv';

/** Dropdown menu (Radix): arrow keys, type-ahead, Escape, focus returns to the trigger. */
export const Menu = M.Root;
export const MenuTrigger = M.Trigger;
export const MenuGroup = M.Group;
export const MenuRadioGroup = M.RadioGroup;
export const MenuSub = M.Sub;

export function MenuContent({
  className,
  sideOffset = 6,
  align = 'end',
  ...rest
}: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        {...rest}
        className={cn(floating(), className)}
      />
    </M.Portal>
  );
}

export function MenuItem({
  className,
  icon,
  shortcut,
  tone,
  children,
  ...rest
}: ComponentProps<typeof M.Item> & { icon?: ReactNode; shortcut?: ReactNode; tone?: 'default' | 'danger' }) {
  return (
    <M.Item {...rest} className={floatingItem({ tone, className })}>
      {icon && <span className="flex shrink-0 text-fg-3">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <span className="ml-4 shrink-0 text-xs text-fg-3">{shortcut}</span>}
    </M.Item>
  );
}

export function MenuCheckboxItem({ className, children, ...rest }: ComponentProps<typeof M.CheckboxItem>) {
  return (
    <M.CheckboxItem {...rest} className={floatingItem({ inset: true, className })}>
      <M.ItemIndicator className="absolute left-2 flex text-accent">
        <CheckIcon size={14} weight="bold" aria-hidden />
      </M.ItemIndicator>
      {children}
    </M.CheckboxItem>
  );
}

export function MenuRadioItem({ className, children, ...rest }: ComponentProps<typeof M.RadioItem>) {
  return (
    <M.RadioItem {...rest} className={floatingItem({ inset: true, className })}>
      <M.ItemIndicator className="absolute left-1 flex text-accent">
        <DotOutlineIcon size={22} weight="fill" aria-hidden />
      </M.ItemIndicator>
      {children}
    </M.RadioItem>
  );
}

export function MenuLabel({ className, ...rest }: ComponentProps<typeof M.Label>) {
  return <M.Label {...rest} className={floatingLabel({ className })} />;
}

export function MenuSeparator({ className, ...rest }: ComponentProps<typeof M.Separator>) {
  return <M.Separator {...rest} className={floatingSeparator({ className })} />;
}
