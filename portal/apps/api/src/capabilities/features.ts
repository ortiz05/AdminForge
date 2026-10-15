import type { TenantLicences } from './licences';

/**
 * Features AdminForge surfaces, and the Microsoft service plans that enable them. Service plan names are
 * Microsoft-published and identical in every tenant; any SKU that contains one of the plans (E3, E5, EMS, Business
 * Premium, …) enables the feature.
 */
export const FEATURES = {
  conditionalAccess: { label: 'Conditional Access', plans: ['AAD_PREMIUM', 'AAD_PREMIUM_P2'], requires: 'Microsoft Entra ID P1 (AAD_PREMIUM)', sku: 'AAD_PREMIUM' },
  pim: { label: 'Privileged Identity Management', plans: ['AAD_PREMIUM_P2'], requires: 'Microsoft Entra ID P2 (AAD_PREMIUM_P2)', sku: 'AAD_PREMIUM_P2' },
  identityProtection: { label: 'Identity Protection (risky users)', plans: ['AAD_PREMIUM_P2'], requires: 'Microsoft Entra ID P2 (AAD_PREMIUM_P2)', sku: 'AAD_PREMIUM_P2' },
  intune: { label: 'Microsoft Intune', plans: ['INTUNE_A', 'INTUNE_EDU', 'INTUNE_SMBIZ'], requires: 'Microsoft Intune Plan 1 (INTUNE_A)', sku: 'INTUNE_A' },
  exchange: {
    label: 'Exchange Online',
    plans: ['EXCHANGE_S_STANDARD', 'EXCHANGE_S_ENTERPRISE', 'EXCHANGE_S_DESKLESS', 'EXCHANGE_S_ESSENTIALS'],
    requires: 'Exchange Online (EXCHANGE_S_STANDARD or EXCHANGE_S_ENTERPRISE)',
    sku: 'EXCHANGESTANDARD',
  },
  teams: { label: 'Microsoft Teams', plans: ['TEAMS1', 'TEAMS_AR_DOD', 'TEAMS_AR_GCCHIGH'], requires: 'Microsoft Teams (TEAMS1)', sku: 'TEAMS1' },
  sharepoint: {
    label: 'SharePoint Online',
    plans: ['SHAREPOINTSTANDARD', 'SHAREPOINTENTERPRISE', 'SHAREPOINT_S_DEVELOPER'],
    requires: 'SharePoint Online (SHAREPOINTSTANDARD or SHAREPOINTENTERPRISE)',
    sku: 'SHAREPOINTSTANDARD',
  },
  defender: {
    label: 'Microsoft Defender (incidents and alerts)',
    plans: ['MTP', 'WINDEFATP', 'MDE_LITE', 'MDE_SMB', 'ATP_ENTERPRISE', 'THREAT_INTELLIGENCE'],
    requires: 'Microsoft Defender XDR / Defender for Endpoint (MTP or WINDEFATP)',
    sku: 'MTP',
  },
  signInLogs: { label: 'Sign-in logs and sign-in activity', plans: ['AAD_PREMIUM', 'AAD_PREMIUM_P2'], requires: 'Microsoft Entra ID P1 (AAD_PREMIUM)', sku: 'AAD_PREMIUM' },
} as const;
export type FeatureKey = keyof typeof FEATURES;

/**
 * `available` is false only when the tenant's licences were read and none enables the feature; when they could not
 * be read, the feature is offered (Microsoft still decides) and `reason` says the licence state is unknown.
 * `sku`: the tenant SKU that provides it when available, otherwise the SKU / service plan that would enable it.
 */
export interface FeatureState {
  available: boolean;
  reason?: string;
  sku?: string;
  label: string;
  servicePlans: string[];
}

export function featureStates(lic: TenantLicences | null): Record<FeatureKey, FeatureState> {
  const out = {} as Record<FeatureKey, FeatureState>;
  for (const [key, f] of Object.entries(FEATURES) as Array<[FeatureKey, (typeof FEATURES)[FeatureKey]]>) {
    const base = { label: f.label, servicePlans: [...f.plans] };
    if (!lic) {
      out[key] = { ...base, available: true, reason: 'Licence information could not be read; availability is unknown.', sku: f.sku };
      continue;
    }
    const plan = f.plans.find((p) => lic.names.has(p));
    out[key] = plan ? { ...base, available: true, ...(lic.providedBy.get(plan) ? { sku: lic.providedBy.get(plan)! } : {}) } : { ...base, available: false, reason: `Requires ${f.requires}`, sku: f.sku };
  }
  return out;
}
