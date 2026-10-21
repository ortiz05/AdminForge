import { useId, useState, type ReactNode } from 'react';
import type { Scope } from '@adminforge/expressions';
import type { RowAction } from '@adminforge/schemas';
import {
  ArrowSquareOutIcon,
  Button,
  Icon,
  LockSimpleIcon,
  MenuItem,
  Tooltip,
  button,
  cn,
  followSafeUrl,
  safeUrl,
  type ButtonProps,
} from '@adminforge/ui';
import type { PlaybookWriteState, WidgetRuntime } from '../types';
import { evaluateTemplate, useTemplate, useWhen } from './expr';
import type { ActionSpec } from './schema-common';

/** Why a content action's link shows as text: its target (from data) isn't an address AdminForge opens. */
export const UNSAFE_LINK_REASON = 'This link’s address isn’t one AdminForge opens, so it is shown as text.';

/** "identity.disable-user" → "Disable user" (when content gives no label). */
export function playbookLabel(key: string): string {
  const name = key.split('.').pop() ?? key;
  const words = name.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Renders inputs with the given scope and opens the playbook drawer. */
export async function launchPlaybook(
  runtime: WidgetRuntime,
  playbook: string,
  inputs: Record<string, unknown> | undefined,
  scope: Scope,
): Promise<void> {
  const rendered = inputs ? await evaluateTemplate<Record<string, unknown>>(inputs, scope) : undefined;
  runtime.openPlaybook({
    playbook,
    ...(rendered && Object.keys(rendered).length ? { inputs: rendered } : {}),
  });
}

/**
 * Follows a content action's href (already evaluated) when it is a safe target (`followSafeUrl`) — in the app through
 * the router, an external one (or any, with `external`) in a new tab. Anything else (javascript:, //host, /\host,
 * data:) is ignored: never navigates.
 */
export function followHref(runtime: WidgetRuntime, href: unknown, external?: boolean): boolean {
  return followSafeUrl(href, (to) => runtime.navigate(to), { newTab: external });
}

const NO_WRITE: NonNullable<WidgetRuntime['usePlaybookWrite']> = () => undefined;

/** `runtime.usePlaybookWrite` for an action (nothing outside the app: tests and previews know no write access). */
export function usePlaybookWriteState(
  runtime: WidgetRuntime,
  playbook: string | undefined,
): PlaybookWriteState | undefined {
  const usePlaybookWrite = runtime.usePlaybookWrite ?? NO_WRITE;
  return usePlaybookWrite(playbook);
}

/** The lock glyph of a write action while unarmed (the same glyph as a locked Button). */
export function WriteLockGlyph({ size = 14 }: { size?: number }) {
  return <LockSimpleIcon size={size} weight="bold" aria-hidden className="shrink-0" data-write-lock="" />;
}

/** The ember dot of a write action while write access is armed (CSS shows it only in armed mode). */
export function ArmedDot() {
  return <span className="af-armed-dot" aria-hidden />;
}

/**
 * How a content action that runs a playbook stands with write access — the one rule for every place an action shows
 * (buttons, "More actions", a table's row menu and bulk bar; D-18): a write playbook shows the lock glyph and why while
 * unarmed (still clickable: the drawer previews without write access) and the ember dot once armed; a read playbook,
 * a link, or a runtime that knows nothing about write access shows neither.
 */
export interface WriteLock {
  /** Unarmed write: why running it waits — the control's description, next to the lock glyph. */
  hint: string | undefined;
  /** Armed write: the ember dot follows the label. */
  armed: boolean;
  /** Id of the hidden description (`WriteHint`) for the control's `aria-describedby`. */
  hintId: string;
}

export function useWriteLock(runtime: WidgetRuntime, playbook: string | undefined): WriteLock {
  const write = usePlaybookWriteState(runtime, playbook);
  const hintId = useId();
  return { hint: write && !write.armed ? write.hint : undefined, armed: write?.armed === true, hintId };
}

/** A control's description, kept out of its name: `hidden`, which `aria-describedby` still reads. */
export function HiddenDescription({ id, text }: { id: string; text: string | undefined }) {
  return text ? (
    <span id={id} hidden>
      {text}
    </span>
  ) : null;
}

export interface PlaybookButtonProps {
  runtime: WidgetRuntime;
  playbook: string;
  /** The action's own icon; a write lock takes its place while unarmed (one glyph, and it says why). */
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  pending?: boolean;
  /** Inert, with this reason (too many rows selected): wins over the write lock. */
  locked?: string;
  size?: ButtonProps['size'];
  intent?: ButtonProps['intent'];
  className?: string;
}

/** A button that launches a playbook, marked for write access (`useWriteLock`): content action buttons, bulk bars. */
export function PlaybookButton({
  runtime,
  playbook,
  icon,
  children,
  onClick,
  pending,
  locked,
  size = 'md',
  intent = 'secondary',
  className,
}: PlaybookButtonProps) {
  const lock = useWriteLock(runtime, playbook);
  const lockHint = locked ? undefined : lock.hint;
  const control = (
    <Button
      size={size}
      intent={intent}
      className={className}
      pending={pending}
      locked={locked}
      aria-describedby={lockHint ? lock.hintId : undefined}
      onClick={onClick}
    >
      {lockHint ? <WriteLockGlyph /> : icon}
      {children}
      {lock.armed && <ArmedDot />}
      <HiddenDescription id={lock.hintId} text={lockHint} />
    </Button>
  );
  return lockHint ? (
    <Tooltip content={lockHint} side="bottom">
      {control}
    </Tooltip>
  ) : (
    control
  );
}

/** What a row or page action is called when content gives no label. */
export const actionLabel = (a: Pick<RowAction, 'label' | 'playbook'>) =>
  a.label ?? (a.playbook ? playbookLabel(a.playbook) : 'Open link');

/**
 * One action in a menu (a table row's menu, an entity's "More actions"). A link is judged by its evaluated target with
 * the shared rule (`safeUrl`): an external one says it opens a new tab; one that isn't safe (javascript:, //host,
 * /\host, …) is a disabled item — text that never navigates — and says why. A write playbook carries the write lock or
 * the ember dot (`useWriteLock`). `onRun` gets the safe target for a link.
 */
export function ActionMenuItem({
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
  const lock = useWriteLock(runtime, action.playbook);
  const safe = action.href && typeof href.value === 'string' ? safeUrl(href.value) : null;
  // Still evaluating isn't unsafe: the item waits (disabled) without a reason.
  const unsafe = Boolean(action.href) && !href.pending && !safe;
  const description = lock.hint ?? (unsafe ? UNSAFE_LINK_REASON : undefined);
  return (
    <MenuItem
      icon={action.icon ? <Icon name={action.icon} size={15} /> : undefined}
      disabled={unsafe || (Boolean(action.href) && href.pending)}
      title={unsafe ? UNSAFE_LINK_REASON : undefined}
      aria-describedby={description ? lock.hintId : undefined}
      shortcut={
        safe?.external ? (
          <ArrowSquareOutIcon size={12} aria-hidden />
        ) : lock.hint ? (
          <WriteLockGlyph size={12} />
        ) : lock.armed ? (
          <ArmedDot />
        ) : undefined
      }
      onSelect={() => onRun(safe?.href)}
    >
      {actionLabel(action)}
      {safe?.external && (
        <>
          {' '}
          <span className="sr-only">(opens in a new tab)</span>
        </>
      )}
      <HiddenDescription id={lock.hintId} text={description} />
    </MenuItem>
  );
}

export interface ActionButtonProps {
  action: ActionSpec;
  scope: Scope;
  runtime: WidgetRuntime;
  size?: ButtonProps['size'];
  intent?: ButtonProps['intent'];
  className?: string;
}

/**
 * A content action: launches a playbook (the drawer handles preflight and write access) or follows a link.
 * Hidden while its `when` is false. Buttons say exactly what happens (§6.9) — the label comes from content.
 * A write playbook shows a lock glyph and why while unarmed (still clickable: the drawer previews without write
 * access) and the ember dot once armed, like coded screens' WriteAction.
 */
export function ActionButton({
  action,
  scope,
  runtime,
  size = 'md',
  intent = 'secondary',
  className,
}: ActionButtonProps) {
  const visible = useWhen(action.when, scope);
  const href = useTemplate<string>(action.href, scope, Boolean(action.href));
  const [busy, setBusy] = useState(false);
  if (!visible) return null;
  const icon = action.icon ? <Icon name={action.icon} size={size === 'sm' ? 14 : 16} /> : null;

  if (action.href) {
    // Templated from data: only safe targets become links (never javascript:, //host or /\host). Nothing to link to
    // (yet) shows nothing; an unsafe target shows as text.
    if (typeof href.value !== 'string' || !href.value) return null;
    const safe = safeUrl(href.value);
    if (!safe)
      return (
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 text-fg-3',
            size === 'sm' ? 'h-7 text-xs' : 'h-(--af-control-h)',
            className,
          )}
          data-unsafe-href=""
          title={UNSAFE_LINK_REASON}
        >
          {icon}
          {action.label}
          <span className="sr-only">. {UNSAFE_LINK_REASON}</span>
        </span>
      );
    const target = safe.href;
    const external = safe.external || action.external === true;
    const cls = button({ intent, size, className });
    if (external)
      return (
        <a href={target} target="_blank" rel="noreferrer" className={cls}>
          {icon}
          {action.label}
          <ArrowSquareOutIcon size={12} aria-hidden className="text-fg-3" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      );
    const L = runtime.Link;
    return (
      <L href={target} className={cls}>
        {icon}
        {action.label}
      </L>
    );
  }

  return (
    <PlaybookButton
      runtime={runtime}
      playbook={action.playbook!}
      icon={icon}
      size={size}
      intent={intent}
      className={className}
      pending={busy}
      onClick={() => {
        setBusy(true);
        void launchPlaybook(runtime, action.playbook!, action.inputs, scope).finally(() => setBusy(false));
      }}
    >
      {action.label}
    </PlaybookButton>
  );
}
