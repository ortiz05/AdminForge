import { tv } from './tv';

export const kbd = tv({
  slots: {
    group: 'inline-flex items-center gap-0.5',
    key: [
      'inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line border-b-line-strong',
      'bg-raised px-1 font-mono text-2xs leading-none font-medium text-fg-2',
    ],
  },
});
