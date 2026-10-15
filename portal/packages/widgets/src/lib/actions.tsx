import { useState } from 'react';
import type { Scope } from '@adminforge/expressions';
import { ArrowSquareOutIcon, Button, Icon, button, type ButtonProps } from '@adminforge/ui';
import type { WidgetRuntime } from '../types';
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
    const target = typeof href.value === 'string' ? href.value : '';
    if (!target) return null;
    const external = action.external ?? isExternal(target);
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
    <Button
      size={size}
      intent={intent}
      className={className}
      pending={busy}
      onClick={() => {
        setBusy(true);
        void launchPlaybook(runtime, action.playbook!, action.inputs, scope).finally(() => setBusy(false));
      }}
    >
      {icon}
      {action.label}
    </Button>
  );
}
