import { lazy, Suspense, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { PlayIcon } from '@adminforge/ui';

// The live list (run contracts, SSE, status glyphs) loads after first paint; the frame and idle text don't wait.
const DockRuns = lazy(() => import('../runs/DockRuns'));

const IDLE = 'No runs in this session. Playbooks you start appear here with live progress.';

/**
 * The bottom bar: my active runs with live progress; click one to open its timeline (see runs/DockRuns).
 * `trailing` carries the developer toolbar in mock mode.
 */
export function RunDock({ trailing }: { trailing?: ReactNode }) {
  return (
    <footer
      aria-label="Runs"
      className="fixed inset-x-0 bottom-0 z-(--af-z-dock) flex h-(--af-layout-dock-h) items-center gap-3 border-t border-line bg-panel px-4 text-xs"
    >
      <Link to="/runs" className="af-eyebrow flex shrink-0 items-center gap-1.5 hover:text-fg">
        <PlayIcon size={11} weight="fill" aria-hidden />
        Runs
      </Link>
      <Suspense fallback={<span className="truncate text-fg-3">{IDLE}</span>}>
        <DockRuns />
      </Suspense>
      {trailing && <span className="ml-auto flex shrink-0 items-center gap-2">{trailing}</span>}
    </footer>
  );
}
