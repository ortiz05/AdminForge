import { tv } from './tv';

export const idChip = tv({
  slots: {
    // One line always (the chip is 24 px tall): in a narrow place the value is cut off, never wrapped.
    root: 'inline-flex h-6 max-w-full items-center gap-1 rounded-sm border border-line bg-sunken pr-0.5 pl-1.5 text-xs leading-none whitespace-nowrap',
    label: 'shrink-0 text-fg-3',
    value: 'min-w-0 truncate font-mono tabular-nums text-fg-2',
    copy: [
      'inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-3',
      'hover:bg-hover hover:text-fg transition-colors duration-(--af-motion-fast)',
    ],
  },
  variants: { copied: { true: { copy: 'text-ok hover:text-ok' } } },
});
