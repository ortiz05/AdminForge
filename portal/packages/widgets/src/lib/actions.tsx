import { useId, useState } from 'react';
import type { Scope } from '@adminforge/expressions';
import {
  ArrowSquareOutIcon,
  Button,
  Icon,
  LockSimpleIcon,
  Tooltip,
  button,
  cn,
  safeUrl,
  type ButtonProps,
} from '@adminforge/ui';
import type { PlaybookWriteState, WidgetRuntime } from '../types';
import { evaluateTemplate, useTemplate, useWhen } from './expr';
import type { ActionSpec } from './schema-common';

export const isExternal = (href: string) => /^https?:\/\//i.test(href);

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
 * Follows a content action's href (already evaluated) when it is a safe target — in the app through the router, an
 * external one in a new tab. Anything else (javascript:, //host, /\host, data:) is ignored: never navigates.
 */
export function followHref(runtime: WidgetRuntime, href: unknown, external?: boolean): boolean {
  const safe = typeof href === 'string' ? safeUrl(href) : null;
  if (!safe) return false;
  if (safe.external || external) window.open(safe.href, '_blank', 'noopener,noreferrer');
  else runtime.navigate(safe.href);
  return true;
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
  const write = usePlaybookWriteState(runtime, action.playbook);
  const hintId = useId();
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
        >
          {icon}
          {action.label}
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

  const lockHint = write && !write.armed ? write.hint : undefined;
  const control = (
    <Button
      size={size}
      intent={intent}
      className={className}
      pending={busy}
      aria-describedby={lockHint ? hintId : undefined}
      onClick={() => {
        setBusy(true);
        void launchPlaybook(runtime, action.playbook!, action.inputs, scope).finally(() => setBusy(false));
      }}
    >
      {/* Locked, the lock takes the icon's place: one glyph, and it says why. */}
      {lockHint ? <WriteLockGlyph /> : icon}
      {action.label}
      {write?.armed && <span className="af-armed-dot" aria-hidden />}
      {/* `hidden`: not part of the button's name, still its description (aria-describedby reads hidden nodes). */}
      {lockHint && (
        <span id={hintId} hidden>
          {lockHint}
        </span>
      )}
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
