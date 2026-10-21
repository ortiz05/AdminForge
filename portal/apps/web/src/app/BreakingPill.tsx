import { Link } from '@tanstack/react-router';
import { NewspaperIcon, tv } from '@adminforge/ui';

const pill = tv({
  base: [
    // Info, not crit: "breaking" covers advisories and deadlines too, and the pill is on every page. The News page
    // gives each item its own tone (incidents in crit).
    // No outline: in the top bar only the mode pill (Read-only) is outlined.
    'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-pill bg-accent-subtle px-2.5 text-xs font-semibold text-info max-lg:px-2 max-sm:px-1.5',
    'transition-colors duration-(--af-motion-fast) hover:bg-accent/25',
    // In write mode the rail turns ember: the pill follows the rail's ink instead of adding a second colour.
    'armed:bg-on-armed/15 armed:text-on-armed armed:hover:bg-on-armed/25',
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
      // The name starts with what the pill shows ("4 new breaking"), so voice control can say it (WCAG 2.5.3).
      aria-label={`${text} new breaking ${count === 1 ? 'change' : 'changes'}: open News and changes`}
    >
      <NewspaperIcon size={14} weight="fill" aria-hidden />
      <span className="tabular-nums">{text}</span>
      {/* Below `xl` the rail shows the icon and the count (jump-to keeps its room); the name still says what they are. */}
      <span className="max-xl:hidden">new breaking</span>
    </Link>
  );
}
