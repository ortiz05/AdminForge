import { Link } from '@tanstack/react-router';
import { SirenIcon, tv } from '@adminforge/ui';

const pill = tv({
  base: [
    'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-pill border border-crit/40 bg-crit-subtle px-2.5 text-xs font-semibold text-crit',
    'transition-colors duration-(--af-motion-fast) hover:border-crit',
    // In write mode the rail turns ember: the pill follows the rail's ink instead of adding a second alarm colour.
    'armed:border-on-armed/40 armed:bg-on-armed/15 armed:text-on-armed armed:hover:border-on-armed',
  ],
});

/**
 * Top-bar indicator: unread breaking news (active incidents, urgent security advisories, deadlines inside two weeks).
 * Hidden when there is nothing; opens News and changes filtered to breaking items.
 */
export function BreakingPill({ count }: { count: number }) {
  if (count <= 0) return null;
  const text = count > 99 ? '99+' : String(count);
  return (
    <Link
      to="/news"
      search={{ breaking: true }}
      className={pill()}
      aria-label={`${count} unread breaking ${count === 1 ? 'change' : 'changes'}: open News and changes`}
    >
      <SirenIcon size={14} weight="fill" aria-hidden className="motion-safe:animate-pulse" />
      <span className="tabular-nums">{text}</span>
      <span>new breaking</span>
    </Link>
  );
}
