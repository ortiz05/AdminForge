import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Playbook, Requires, Runbook } from '@adminforge/schemas';
import { ArrowSquareOutIcon, Badge, cn, STATUS_ICON, type StatusTone } from '@adminforge/ui';
import { useMe } from '../lib/session';
import { Callout } from '../ops/ui';
import { serviceLabel } from '../runs/PlanView';
import { staticConfirmMessage } from './confirm';
import { capabilitiesQuery, type Capabilities } from './contracts';

/** Generic Entra PIM "My roles → activate" blade (not tenant-specific). */
export const PIM_ACTIVATE_URL =
  'https://entra.microsoft.com/#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadmigratedroles';

const RISK_TEXT: Record<Playbook['risk'], { tone: StatusTone; label: string }> = {
  low: { tone: 'info', label: 'Low risk' },
  medium: { tone: 'info', label: 'Medium risk' },
  high: { tone: 'warn', label: 'High risk' },
  critical: { tone: 'crit', label: 'Critical risk' },
};

/** What running this will do to the tenant and what stands between the engineer and the change (§6.6 risk banner). */
export function RiskBanner({ def, bulkCount }: { def: Playbook | Runbook; bulkCount?: number }) {
  if (def.mode === 'read')
    return (
      <Callout tone="info" title="Read-only">
        This {def.kind} only reads data. Nothing in your tenant changes, and it runs without write access.
      </Callout>
    );
  const risk = RISK_TEXT[def.risk];
  const lines: string[] = [];
  if (bulkCount) {
    lines.push(
      `Runs once per item (${bulkCount} item${bulkCount === 1 ? '' : 's'}), only while write access is armed.`,
    );
    lines.push(
      'Each item runs the playbook’s own checks before it changes anything; follow every item on the run page.',
    );
  } else {
    // A runbook starts read-only: its checklists go on, and each step that changes the tenant waits for write access.
    lines.push(
      def.kind === 'runbook'
        ? 'Steps that change the tenant wait until write access is armed; checklists and read steps don’t need it.'
        : 'Runs only while write access is armed.',
    );
    lines.push(
      'Preview it first: the dry run reads for real and lists every change before anything happens.',
    );
  }
  if (def.confirm?.type === 'typed')
    lines.push(
      bulkCount
        ? 'You’ll type the number of items to confirm.'
        : (staticConfirmMessage(def) ?? 'You’ll type a confirmation before it runs.'),
    );
  else if (def.confirm?.type === 'click')
    lines.push(`You’ll confirm before it ${def.kind === 'runbook' ? 'starts' : 'runs'}.`);
  if (def.approval?.required)
    lines.push(
      `A ${def.approval.approvers?.join(' or ') ?? 'Playbook Approver'} must approve before the changes are made${def.approval.expiresIn ? ` (the request expires after ${def.approval.expiresIn})` : ''}.`,
    );
  return (
    <Callout tone={risk.tone} title={`Changes your tenant · ${risk.label}`}>
      <ul className="flex list-disc flex-col gap-0.5 pl-4">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </Callout>
  );
}

type Check = { tone: StatusTone; text: string };

function Row({
  label,
  sub,
  check,
  children,
}: {
  label: string;
  sub?: string;
  check?: Check;
  children?: ReactNode;
}) {
  const Glyph = check ? STATUS_ICON[check.tone] : null;
  return (
    <li className="flex flex-col gap-1 border-t border-line px-3 py-2 first:border-t-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0">
          <span className="font-medium text-fg">{label}</span>
          {sub && <span className="ml-2 text-xs text-fg-3">{sub}</span>}
        </span>
        {check && Glyph && (
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 text-xs font-medium',
              {
                ok: 'text-ok',
                warn: 'text-warn',
                crit: 'text-crit',
                info: 'text-info',
                neutral: 'text-fg-3',
              }[check.tone],
            )}
          >
            <Glyph size={13} weight="fill" aria-hidden />
            {check.text}
          </span>
        )}
      </div>
      {children}
    </li>
  );
}

function entraRoleCheck(
  role: string,
  caps: Capabilities | undefined,
  loading: boolean,
): Check & { eligible?: boolean } {
  if (loading) return { tone: 'neutral', text: 'Checking…' };
  if (!caps || caps.active === null) return { tone: 'neutral', text: 'Couldn’t check' };
  const same = (r: { displayName: string }) => r.displayName.toLowerCase() === role.toLowerCase();
  if (caps.active.some(same)) return { tone: 'ok', text: 'Active' };
  if (caps.active.some((r) => r.displayName === 'Global Administrator'))
    return { tone: 'ok', text: 'Covered by Global Administrator' };
  if (caps.eligible?.some(same)) return { tone: 'warn', text: 'Eligible — activate in PIM', eligible: true };
  return { tone: 'crit', text: 'Not assigned' };
}

/** `requires`: portal roles, Entra roles (with PIM activation when only eligible), licences, and the permissions used. */
export function Requirements({ requires, writes }: { requires: Requires | undefined; writes: boolean }) {
  const me = useMe();
  const needsCaps = Boolean(requires?.entraRoles?.length || requires?.licences?.length);
  const caps = useQuery({ ...capabilitiesQuery, enabled: needsCaps });
  if (!requires) return null;

  const portal = requires.portalRoles ?? [];
  const entra = requires.entraRoles ?? [];
  const licences = requires.licences ?? [];
  const scopes = Object.entries(requires.scopes ?? {}).filter(
    (e): e is [string, string[]] => Array.isArray(e[1]) && e[1].length > 0,
  );
  const entraChecks = entra.map((r) => ({
    role: r,
    check: entraRoleCheck(r, caps.data, caps.isPending && needsCaps),
  }));
  const eligible = entraChecks.filter((c) => c.check.eligible);

  if (!portal.length && !entra.length && !licences.length && !scopes.length) return null;
  return (
    <section aria-label="What you need" className="flex flex-col gap-2">
      <h3 className="af-eyebrow">What you need</h3>
      <ul className="overflow-hidden rounded-(--af-panel-radius) border border-line bg-panel text-sm">
        {portal.map((r) => (
          <Row
            key={r}
            label={r}
            sub="AdminForge role"
            check={
              me.roles.includes(r) || me.roles.includes('Portal.Admin')
                ? { tone: 'ok', text: 'You have it' }
                : { tone: 'crit', text: 'Missing — ask a Portal Admin' }
            }
          />
        ))}
        {entraChecks.map(({ role, check }) => (
          <Row key={role} label={role} sub="Microsoft Entra role" check={check} />
        ))}
        {licences.map((l) => {
          // Content names licence features (pim, signInLogs, intune…); a bare SKU part number also works.
          const feature = caps.data?.features[l];
          const has = feature
            ? feature.available
            : caps.data?.skus == null
              ? null
              : caps.data.skus.includes(l);
          const label = feature?.label ?? l;
          return (
            <Row
              key={l}
              label={label}
              sub="Licence"
              check={
                has === null || has === undefined
                  ? { tone: 'neutral', text: caps.isPending ? 'Checking…' : 'Couldn’t check' }
                  : has
                    ? { tone: 'ok', text: 'Licensed' }
                    : { tone: 'warn', text: `Requires ${label}` }
              }
            />
          );
        })}
        {scopes.map(([service, list]) => (
          <Row
            key={service}
            label={serviceLabel(service === 'connections' ? 'function' : service)}
            sub={writes ? 'Permissions this uses' : 'Permissions'}
          >
            <span className="flex flex-wrap gap-1">
              {list.map((s) => (
                <Badge key={s} mono>
                  {s}
                </Badge>
              ))}
            </span>
          </Row>
        ))}
      </ul>
      {eligible.length > 0 && (
        <Callout
          tone="warn"
          title={`Activate ${eligible.map((e) => e.role).join(' and ')} in PIM to use this`}
          action={
            <a
              href={PIM_ACTIVATE_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline"
            >
              Activate in PIM
              <ArrowSquareOutIcon size={13} aria-hidden />
              <span className="sr-only">(opens Microsoft Entra in a new tab)</span>
            </a>
          }
        >
          You hold the role as eligible. Activate it, then preview again — new permissions can take a few
          minutes to apply across Microsoft services.
        </Callout>
      )}
    </section>
  );
}
