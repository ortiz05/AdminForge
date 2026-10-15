import { useId } from 'react';
import { Badge, FlaskIcon, LockKeyIcon, cn } from '@adminforge/ui';
import type { FeatureState, WidgetProps } from '../../types';
import type { LicenceGateConfig } from './schema';

/** What each licensable feature is called and what it takes (docs/licensing-review.md). */
export const FEATURE_INFO: Record<string, { label: string; sku: string }> = {
  conditionalAccess: { label: 'Conditional Access', sku: 'Microsoft Entra ID P1 (AAD_PREMIUM)' },
  pim: { label: 'Privileged Identity Management', sku: 'Microsoft Entra ID P2 (AAD_PREMIUM_P2)' },
  identityProtection: { label: 'Identity Protection', sku: 'Microsoft Entra ID P2 (AAD_PREMIUM_P2)' },
  intune: { label: 'Microsoft Intune', sku: 'Microsoft Intune Plan 1 (INTUNE_A)' },
  exchange: { label: 'Exchange Online', sku: 'Exchange Online (EXCHANGE_S_STANDARD or EXCHANGE_S_ENTERPRISE)' },
  teams: { label: 'Microsoft Teams', sku: 'Microsoft Teams (TEAMS1)' },
  sharepoint: { label: 'SharePoint Online', sku: 'SharePoint Online (SHAREPOINTSTANDARD or SHAREPOINTENTERPRISE)' },
  defender: { label: 'Microsoft Defender', sku: 'Microsoft Defender for Endpoint, Office 365 or XDR (WINDEFATP, ATP_ENTERPRISE, MTP)' },
  defenderEndpoint: { label: 'Microsoft Defender for Endpoint', sku: 'Microsoft Defender for Endpoint (WINDEFATP or MDE_LITE)' },
  defenderOffice: { label: 'Microsoft Defender for Office 365', sku: 'Defender for Office 365 (ATP_ENTERPRISE)' },
  defenderXdr: { label: 'Microsoft Defender XDR', sku: 'Microsoft Defender XDR (MTP)' },
  signInLogs: { label: 'Sign-in logs', sku: 'Microsoft Entra ID P1 (AAD_PREMIUM)' },
  entraP1: { label: 'Microsoft Entra ID P1', sku: 'Microsoft Entra ID P1 (AAD_PREMIUM)' },
  entraP2: { label: 'Microsoft Entra ID P2', sku: 'Microsoft Entra ID P2 (AAD_PREMIUM_P2)' },
};

export interface MissingFeature {
  key: string;
  state?: FeatureState;
}

const nameOf = (f: MissingFeature) => f.state?.label ?? FEATURE_INFO[f.key]?.label ?? f.key;
const skuOf = (f: MissingFeature) => f.state?.sku ?? FEATURE_INFO[f.key]?.sku;

/** "Intune" / "Intune and Exchange Online" / "A, B and C". */
const joinNames = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

export interface LicenceGatePanelProps {
  missing: MissingFeature[];
  /** Mock mode: say the page shows sample data instead of blocking it. */
  preview?: boolean;
  title?: string;
  /** What the page would show ("managed devices and their compliance"). */
  body?: string;
  className?: string;
}

/**
 * Explains a missing licence (R10): what's missing, the exact SKU / service plan, and what to do. In mock mode it
 * becomes a slim "Preview with sample data" banner above fixture-backed content.
 */
export function LicenceGatePanel({ missing, preview, title, body, className }: LicenceGatePanelProps) {
  const titleId = useId();
  const names = joinNames(missing.map(nameOf));
  const skus = [...new Set(missing.map(skuOf).filter((s): s is string => Boolean(s)))];
  const reasons = [...new Set(missing.map((m) => m.state?.reason).filter((r): r is string => Boolean(r)))];

  if (preview)
    return (
      <div
        role="note"
        aria-label="Preview with sample data"
        className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-raised px-4 py-2.5 text-sm', className)}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-accent-subtle text-accent">
          <FlaskIcon size={14} weight="bold" aria-hidden />
        </span>
        <span className="font-semibold text-fg">Preview with sample data</span>
        <span className="min-w-0 flex-1 text-fg-2">
          {names} {missing.length > 1 ? 'aren’t' : 'isn’t'} licensed in this tenant, so this page shows synthetic data. Live data
          appears once {skus.length ? skus.join(' and ') : 'the licence'} is assigned.
        </span>
      </div>
    );

  return (
    <section
      aria-labelledby={titleId}
      className={cn('flex gap-4 rounded-(--af-panel-radius) border border-line bg-panel p-(--af-pad-panel)', className)}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-subtle text-accent">
        <LockKeyIcon size={20} weight="duotone" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-col gap-2">
        <p className="af-eyebrow">Requires a licence</p>
        <h2 id={titleId} className="text-md font-semibold text-fg">
          {title ?? `${names} ${missing.length > 1 ? 'aren’t' : 'isn’t'} licensed in this tenant`}
        </h2>
        <p className="max-w-2xl text-sm text-fg-2">
          {body ? `This page shows ${body}. ` : ''}
          {reasons.length ? `${reasons.join(' ')} ` : ''}
          Ask your licensing admin to assign {skus.length ? 'it' : 'the licence'}; the page works as soon as the licence is active,
          with no change in AdminForge.
        </p>
        {skus.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {skus.map((s) => (
              <Badge key={s} tone="outline" mono>
                {s}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** Renders nothing when the feature is licensed (or the state is unknown); otherwise explains what's missing. */
export function LicenceGateWidget({ config, runtime }: WidgetProps<LicenceGateConfig>) {
  const state = runtime.feature(config.feature);
  if (!state || state.available !== false) return null;
  return (
    <LicenceGatePanel
      missing={[{ key: config.feature, state }]}
      preview={runtime.dataMode === 'fixtures'}
      title={config.title}
      body={config.body}
    />
  );
}
