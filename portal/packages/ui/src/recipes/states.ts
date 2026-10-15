import { tv } from './tv';

export const feedbackState = tv({
  slots: {
    root: 'flex flex-col items-center justify-center gap-3 px-6 py-10 text-center',
    glyph: 'flex size-10 items-center justify-center rounded-lg border',
    title: 'text-md font-semibold text-fg',
    body: 'max-w-md text-sm text-fg-2',
    meta: 'flex flex-wrap items-center justify-center gap-2',
    actions: 'mt-1 flex flex-wrap items-center justify-center gap-2',
  },
  variants: {
    tone: {
      empty: { glyph: 'border-line bg-raised text-fg-3' },
      error: { glyph: 'border-transparent bg-crit-subtle text-crit' },
    },
    compact: { true: { root: 'py-6', glyph: 'size-8 rounded-md' } },
  },
});
