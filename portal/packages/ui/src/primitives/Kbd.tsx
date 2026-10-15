import { kbd } from '../recipes/kbd';

export interface KbdProps {
  /** One key ("K") or a chord (["Ctrl", "K"]). */
  keys: string | string[];
  className?: string;
}

/** Keyboard key caps. Chords read as "Ctrl K" to screen readers. */
export function Kbd({ keys, className }: KbdProps) {
  const list = Array.isArray(keys) ? keys : [keys];
  const s = kbd();
  return (
    <span className={s.group({ className })}>
      {list.map((k) => (
        <kbd key={k} className={s.key()} aria-hidden>
          {k}
        </kbd>
      ))}
      <span className="sr-only">{list.join(' ')}</span>
    </span>
  );
}

/** "⌘" on Apple platforms, "Ctrl" elsewhere. */
export function modKey(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
}
