import { initials } from '../lib/format';
import { avatar } from '../recipes/avatar';

/** Initials for a person. Decorative: the name is always rendered or labelled nearby. */
export function Avatar({ name, size, className }: { name: string; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span aria-hidden className={avatar({ size, className })}>
      {initials(name)}
    </span>
  );
}
