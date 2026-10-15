import { tv } from './tv';

export const toast = tv({
  slots: {
    viewport: [
      'fixed right-4 bottom-(--af-layout-dock-h) z-(--af-z-toast) mb-4 flex w-96 max-w-full flex-col gap-2 outline-none',
    ],
    root: [
      'af-toast relative flex items-start gap-3 rounded-lg border border-line-strong bg-raised py-3 pr-10 pl-3.5 text-fg shadow-2',
    ],
    icon: 'mt-0.5 shrink-0',
    title: 'text-sm font-semibold text-fg',
    description: 'mt-0.5 text-sm text-fg-2',
    action: 'mt-2',
    close:
      'absolute top-2 right-2 inline-flex size-6 items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg',
  },
  variants: {
    tone: {
      ok: { icon: 'text-ok' },
      warn: { icon: 'text-warn' },
      crit: { icon: 'text-crit' },
      info: { icon: 'text-info' },
      neutral: { icon: 'text-fg-3' },
    },
  },
});
