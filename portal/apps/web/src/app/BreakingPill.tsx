import { Link } from '@tanstack/react-router';
import { NewspaperIcon, tv } from '@adminforge/ui';

const pill = tv({
  base: [
    // Info, not crit: "breaking" covers advisories and deadlines too, and the pill is on every page. The News page
    // gives each item its own tone (incidents in crit).
    'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-pill border border-accent/40 bg-accent-subtle px-2.5 text-xs font-semibold text-info',
    'transition-colors duration-(--af-motion-fast) hover:border-accent',
    // In write mode the rail turns ember: the pill follows the rail's ink instead of adding a second colour.
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
      <NewspaperIcon size={14} weight="fill" aria-hidden />
      <span className="tabular-nums">{text}</span>
      <span>new breaking</span>
    </Link>
  );
}
