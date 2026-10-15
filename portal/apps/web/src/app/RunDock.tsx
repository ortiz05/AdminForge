import type { ReactNode } from 'react';
import { PlayIcon } from '@adminforge/ui';

/**
 * Live runs (SSE) arrive in Phase 4; until then the dock holds its place and says so.
 * `trailing` carries the developer toolbar in mock mode.
 */
export function RunDock({ trailing }: { trailing?: ReactNode }) {
  return (
    <footer
      aria-label="Runs"
      className="fixed inset-x-0 bottom-0 z-(--af-z-dock) flex h-(--af-layout-dock-h) items-center gap-3 border-t border-line bg-panel px-4 text-xs"
    >
      <span className="af-eyebrow flex items-center gap-1.5">
        <PlayIcon size={11} weight="fill" aria-hidden />
        Runs
      </span>
      <span className="text-fg-3">
        No runs in this session. Playbooks you start appear here with live progress.
      </span>
      {trailing && <span className="ml-auto flex items-center gap-2">{trailing}</span>}
    </footer>
  );
}
