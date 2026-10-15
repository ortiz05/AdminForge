import { ActionButton } from '../../lib/actions';
import type { WidgetProps } from '../../types';
import type { ActionBarConfig } from './schema';

/**
 * Playbook launchers and deep links in one row. Playbooks open the playbook drawer (which runs preflight and asks
 * to arm write access when needed); links to Microsoft portals open in a new tab.
 */
export function ActionBarWidget({ config, runtime }: WidgetProps<ActionBarConfig>) {
  return (
    <div role="group" aria-label={config.title ?? 'Actions'} className="flex flex-wrap items-center gap-2">
      {config.title && <span className="af-eyebrow mr-2">{config.title}</span>}
      {config.actions.map((a, i) => (
        <ActionButton
          key={`${a.playbook ?? a.href}-${i}`}
          action={a}
          scope={runtime.scope}
          runtime={runtime}
          intent="secondary"
        />
      ))}
    </div>
  );
}
