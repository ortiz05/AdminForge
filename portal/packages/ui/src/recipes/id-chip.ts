import { tv } from './tv';

export const idChip = tv({
  slots: {
    root: 'inline-flex h-6 max-w-full items-center gap-1 rounded-sm border border-line bg-sunken pr-0.5 pl-1.5 text-xs leading-none',
    label: 'text-fg-3',
    value: 'font-mono tabular-nums text-fg-2',
    copy: [
      'inline-flex size-5 items-center justify-center rounded-sm text-fg-3',
      'hover:bg-hover hover:text-fg transition-colors duration-(--af-motion-fast)',
    ],
  },
  variants: { copied: { true: { copy: 'text-ok hover:text-ok' } } },
});
