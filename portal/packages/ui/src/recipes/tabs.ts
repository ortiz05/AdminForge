import { tv } from './tv';

export const tabs = tv({
  slots: {
    list: 'flex items-end gap-1 border-b border-line',
    trigger: [
      'relative -mb-px inline-flex h-(--af-control-h) items-center gap-1.5 border-b-2 border-transparent px-2.5 font-medium whitespace-nowrap',
      'text-fg-3 transition-colors duration-(--af-motion-fast) hover:text-fg',
      'state-active:border-accent state-active:text-fg disabled:cursor-not-allowed disabled:opacity-55',
    ],
    content: 'pt-4 outline-none',
  },
});
