import { tv } from './tv';

export const codeBlock = tv({
  slots: {
    root: 'relative min-w-0 overflow-hidden rounded-md border border-line bg-sunken',
    bar: 'flex h-8 items-center justify-between gap-2 border-b border-line pr-1 pl-3',
    title: 'truncate font-mono text-2xs text-fg-3',
    pre: 'm-0 overflow-auto p-3 font-mono text-xs leading-relaxed text-fg-2',
  },
  variants: { wrap: { true: { pre: 'break-all whitespace-pre-wrap' } } },
});
