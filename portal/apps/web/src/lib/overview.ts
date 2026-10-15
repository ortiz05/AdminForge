import { queryOptions } from '@tanstack/react-query';
import type { StatusTone } from '@adminforge/ui';
import { api, isRecord, type Parser } from './api';

/**
 * GET /api/overview (temporary coded endpoint, Task 1.18; becomes a YAML dashboard in Phase 3).
 * Not yet in @adminforge/schemas — this guard is the client side of the contract until it is.
 */
export interface OverviewProvenance {
  service: string;
  path: string;
  ms: number;
  requestId?: string;
  cachedAt?: string;
}

export interface OverviewResponse {
  org: { id: string; name: string; domains: Array<{ name: string; isDefault: boolean; isInitial: boolean }> };
  counts: { users: number; groups: number; apps: number; devices: number };
  skus: Array<{ sku: string; used: number; total: number }>;
  health:
    | { items: Array<{ service: string; status: string }> }
    | { error: { code: string; message: string; hint?: string } };
  provenance: Record<string, OverviewProvenance>;
}

const fail = (what: string): never => {
  throw new TypeError(`Overview response: ${what}`);
};

export const OverviewResponse: Parser<OverviewResponse> = {
  parse(input) {
    if (!isRecord(input)) fail('not an object');
    const o = input as Record<string, unknown>;
    if (
      !isRecord(o.org) ||
      typeof o.org.name !== 'string' ||
      typeof o.org.id !== 'string' ||
      !Array.isArray(o.org.domains)
    )
      fail('org');
    if (!isRecord(o.counts)) fail('counts');
    if (!Array.isArray(o.skus)) fail('skus');
    if (!isRecord(o.health) || !(Array.isArray(o.health.items) || isRecord(o.health.error))) fail('health');
    return {
      ...(o as unknown as OverviewResponse),
      provenance: isRecord(o.provenance) ? (o.provenance as OverviewResponse['provenance']) : {},
    };
  },
};

export const overviewQuery = queryOptions({
  queryKey: ['overview'] as const,
  queryFn: ({ signal }) => api('/api/overview', { schema: OverviewResponse, signal }),
  staleTime: 60_000,
});

/** Microsoft 365 service health states → AdminForge status, in plain words. */
export function healthStatus(status: string): { tone: StatusTone; label: string } {
  switch (status) {
    case 'serviceOperational':
      return { tone: 'ok', label: 'Healthy' };
    case 'serviceRestored':
    case 'postIncidentReviewPublished':
    case 'falsePositive':
      return { tone: 'ok', label: 'Restored' };
    case 'investigating':
    case 'investigationSuspended':
      return { tone: 'info', label: 'Investigating' };
    case 'restoringService':
    case 'verifyingService':
    case 'extendedRecovery':
      return { tone: 'warn', label: 'Recovering' };
    case 'serviceDegradation':
      return { tone: 'warn', label: 'Degraded' };
    case 'serviceInterruption':
      return { tone: 'crit', label: 'Interruption' };
    default:
      return { tone: 'neutral', label: status.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() };
  }
}

/** Friendly licence names for common SKU part numbers; unknown ones show the part number. */
const SKU_NAMES: Record<string, string> = {
  SPE_E5: 'Microsoft 365 E5',
  SPE_E3: 'Microsoft 365 E3',
  SPB: 'Microsoft 365 Business Premium',
  O365_BUSINESS_PREMIUM: 'Microsoft 365 Business Standard',
  O365_BUSINESS_ESSENTIALS: 'Microsoft 365 Business Basic',
  ENTERPRISEPACK: 'Office 365 E3',
  ENTERPRISEPREMIUM: 'Office 365 E5',
  STANDARDPACK: 'Office 365 E1',
  EMS: 'Enterprise Mobility + Security E3',
  EMSPREMIUM: 'Enterprise Mobility + Security E5',
  AAD_PREMIUM: 'Microsoft Entra ID P1',
  AAD_PREMIUM_P2: 'Microsoft Entra ID P2',
  INTUNE_A: 'Microsoft Intune Plan 1',
  POWER_BI_PRO: 'Power BI Pro',
  POWER_BI_STANDARD: 'Power BI (free)',
  FLOW_FREE: 'Power Automate (free)',
  TEAMS_EXPLORATORY: 'Teams Exploratory',
  Microsoft_Teams_Enterprise_New: 'Microsoft Teams Enterprise',
  EXCHANGESTANDARD: 'Exchange Online Plan 1',
  PROJECTPREMIUM: 'Project Plan 5',
  VISIOCLIENT: 'Visio Plan 2',
  WIN_DEF_ATP: 'Microsoft Defender for Endpoint P2',
  DEVELOPERPACK_E5: 'Microsoft 365 E5 Developer',
};

export function skuName(sku: string): string {
  return SKU_NAMES[sku] ?? sku.replace(/_/g, ' ');
}
