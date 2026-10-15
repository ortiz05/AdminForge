import { useEffect, useMemo, useState } from 'react';
import type { RowAction } from '@adminforge/schemas';
import type { Scope } from '@adminforge/expressions';
import {
  ArrowSquareOutIcon,
  Button,
  CaretDownIcon,
  Icon,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from '@adminforge/ui';
import {
  ActionButton,
  evaluateTemplate,
  isExternal,
  launchPlaybook,
  playbookLabel,
  type WidgetRuntime,
} from '@adminforge/widgets';

/** Which actions apply now (their `when` holds), in declared order; undefined while evaluating. */
function useVisibleActions(actions: readonly RowAction[], scope: Scope): RowAction[] | undefined {
  const key = useMemo(() => ({ actions, scope }), [actions, scope]);
  const [state, setState] = useState<{ for: unknown; visible: RowAction[] } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all(
      key.actions.map((a) =>
        a.when === undefined
          ? true
          : typeof a.when === 'boolean'
            ? a.when
            : evaluateTemplate(a.when, key.scope).then(Boolean, () => false),
      ),
    ).then((flags) => live && setState({ for: key, visible: key.actions.filter((_, i) => flags[i]) }));
    return () => {
      live = false;
    };
  }, [key]);
  return state?.for === key ? state.visible : undefined;
}

const labelOf = (a: RowAction) => a.label ?? (a.playbook ? playbookLabel(a.playbook) : 'Open link');

/**
 * An entity's actions: the first few as buttons, the rest under "More actions" so a long list never crowds the
 * header (or the 460 px inspector). Playbooks open the playbook drawer; links open in a new tab.
 */
export function ActionGroup({
  actions,
  scope,
  runtime,
  visibleCount = 3,
  size = 'md',
}: {
  actions: readonly RowAction[];
  scope: Scope;
  runtime: WidgetRuntime;
  visibleCount?: number;
  size?: 'sm' | 'md';
}) {
  const visible = useVisibleActions(actions, scope);
  if (!visible?.length) return null;
  const shown = visible.length <= visibleCount + 1 ? visible : visible.slice(0, visibleCount);
  const more = visible.slice(shown.length);
  const run = (a: RowAction) => {
    if (a.playbook) return void launchPlaybook(runtime, a.playbook, a.inputs, scope);
    if (a.href)
      void evaluateTemplate<unknown>(a.href, scope).then((href) => {
        if (typeof href !== 'string' || !href) return;
        if (isExternal(href)) window.open(href, '_blank', 'noopener,noreferrer');
        else runtime.navigate(href);
      });
  };
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Actions">
      {shown.map((a, i) => (
        <ActionButton
          key={`${a.playbook ?? a.href}-${i}`}
          action={{ ...a, when: undefined, label: labelOf(a) }}
          scope={scope}
          runtime={runtime}
          size={size}
        />
      ))}
      {more.length > 0 && (
        <Menu>
          <MenuTrigger asChild>
            <Button size={size} intent="secondary">
              More actions
              <CaretDownIcon size={12} weight="bold" aria-hidden className="text-fg-3" />
            </Button>
          </MenuTrigger>
          <MenuContent className="max-h-(--radix-dropdown-menu-content-available-height) min-w-60 overflow-y-auto">
            {more.map((a, i) => (
              <MenuItem
                key={`${a.playbook ?? a.href}-${i}`}
                icon={a.icon ? <Icon name={a.icon} size={15} /> : undefined}
                shortcut={
                  a.href && /^https?:/i.test(a.href) ? (
                    <ArrowSquareOutIcon size={12} aria-label="Opens in a new tab" />
                  ) : undefined
                }
                onSelect={() => run(a)}
              >
                {labelOf(a)}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}
