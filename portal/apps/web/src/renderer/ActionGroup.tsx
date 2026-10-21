import { useContext, useEffect, useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Playbook, RowAction } from '@adminforge/schemas';
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
  safeUrl,
} from '@adminforge/ui';
import {
  ActionButton,
  WriteLockGlyph,
  evaluateTemplate,
  followHref,
  launchPlaybook,
  playbookLabel,
  usePlaybookWriteState,
  useTemplate,
  type PlaybookWriteState,
  type WidgetRuntime,
} from '@adminforge/widgets';
import { ShellContext } from '../app/shell-context';
import { SessionContext } from '../lib/session';
import { definitionQuery } from '../playbooks/contracts';

export const ARM_TO_RUN = 'Arm write access to run this; previewing it doesn’t need it.';
export const OPERATOR_TO_RUN = 'Running this needs the Portal Operator role; previewing it doesn’t.';

/**
 * The page runtime's `usePlaybookWrite` (D-18): whether a content action's playbook writes — its published `mode`,
 * from the same cached definition the playbook drawer loads — and how that stands with write access. Unarmed, the
 * action shows a lock glyph and this hint but stays clickable (the drawer's preview works without write access).
 */
export function usePlaybookWrite(playbook: string | undefined): PlaybookWriteState | undefined {
  const shell = useContext(ShellContext);
  const me = useContext(SessionContext);
  const q = useQuery({
    ...definitionQuery<Playbook>('playbook', playbook ?? ''),
    enabled: Boolean(playbook),
  });
  if (!playbook || q.data?.def.mode !== 'write') return undefined;
  if (shell?.arm.armed) return { armed: true };
  return { armed: false, hint: me?.canArm === false ? OPERATOR_TO_RUN : ARM_TO_RUN };
}

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
 * One action under "More actions". A link whose target isn't safe (javascript:, //host, /\host, …) shows as a
 * disabled item — text that never navigates; a write playbook shows the lock glyph and why while unarmed.
 */
function MoreItem({
  action,
  scope,
  runtime,
  onRun,
}: {
  action: RowAction;
  scope: Scope;
  runtime: WidgetRuntime;
  onRun: (href: string | undefined) => void;
}) {
  const href = useTemplate<string>(action.href, scope, Boolean(action.href));
  const write = usePlaybookWriteState(runtime, action.playbook);
  const hintId = useId();
  const safe = action.href && typeof href.value === 'string' ? safeUrl(href.value) : null;
  const lockHint = write && !write.armed ? write.hint : undefined;
  return (
    <MenuItem
      icon={action.icon ? <Icon name={action.icon} size={15} /> : undefined}
      disabled={Boolean(action.href) && !safe}
      aria-describedby={lockHint ? hintId : undefined}
      shortcut={
        safe?.external ? (
          <ArrowSquareOutIcon size={12} aria-label="Opens in a new tab" />
        ) : lockHint ? (
          <WriteLockGlyph size={12} />
        ) : write?.armed ? (
          <span className="af-armed-dot" aria-hidden />
        ) : undefined
      }
      onSelect={() => onRun(safe?.href)}
    >
      {labelOf(action)}
      {lockHint && (
        <span id={hintId} hidden>
          {lockHint}
        </span>
      )}
    </MenuItem>
  );
}

/**
 * An entity's actions: the first few as buttons, the rest under "More actions" so a long list never crowds the
 * header (or the 460 px inspector). Playbooks open the playbook drawer; links open in the app or a new tab, and only
 * when they are safe targets.
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
  const run = (a: RowAction, href: string | undefined) => {
    if (a.playbook) return void launchPlaybook(runtime, a.playbook, a.inputs, scope);
    // `href` is the evaluated, safe target (MoreItem); followHref checks it again and ignores anything else.
    if (a.href) followHref(runtime, href);
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
              <MoreItem
                key={`${a.playbook ?? a.href}-${i}`}
                action={a}
                scope={scope}
                runtime={runtime}
                onRun={(href) => run(a, href)}
              />
            ))}
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}
