import { tv } from './tv';

export const commandPalette = tv({
  slots: {
    content: [
      'af-pop relative mt-16 flex max-h-full w-full max-w-xl flex-col self-start overflow-hidden',
      'rounded-xl border border-line-strong bg-raised text-fg shadow-3 outline-none',
    ],
    inputRow: 'flex h-12 items-center gap-2.5 border-b border-line px-4 text-fg-3',
    input: 'h-full min-w-0 flex-1 bg-transparent text-md text-fg outline-none placeholder:text-fg-3',
    list: 'max-h-96 overflow-y-auto overscroll-contain p-1.5',
    empty: 'px-3 py-8 text-center text-sm text-fg-3',
    heading: 'af-eyebrow px-2 pt-2.5 pb-1.5',
    footer: 'flex items-center gap-4 border-t border-line px-4 py-2 text-2xs text-fg-3',
  },
});
