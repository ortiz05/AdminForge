import { FIXED_NOW } from './session';

/** Synthetic fixtures for the renderer e2e suite (things the content backend doesn't serve). */

const ago = (ms: number) => new Date(FIXED_NOW - ms).toISOString();
const HOUR = 3_600_000;

/** GET /api/me/capabilities for a tenant without Intune (everything else licensed). */
export const CAPABILITIES_NO_INTUNE = {
  features: {
    intune: {
      available: false,
      label: 'Microsoft Intune',
      sku: 'Microsoft Intune Plan 1 (INTUNE_A)',
      reason: 'No subscription in this tenant includes the INTUNE_A service plan.',
      servicePlans: ['INTUNE_A', 'INTUNE_EDU', 'INTUNE_SMBIZ'],
    },
    conditionalAccess: { available: true, label: 'Conditional Access', sku: 'SPE_E5' },
    signInLogs: { available: true, label: 'Sign-in logs and sign-in activity', sku: 'SPE_E5' },
    pim: { available: true, label: 'Privileged Identity Management', sku: 'SPE_E5' },
  },
  roles: { active: [], eligible: [], eligibleAvailable: true, activeSource: 'pim' },
};

type Status = 'ok' | 'warn' | 'crit';

function probe(key: string, title: string, kind: string, status: Status, metric: number | null, unit: string, message: string | null, base = metric ?? 0) {
  return {
    key,
    title,
    kind,
    latest: { ts: ago(12 * 60_000), status, metric, unit, message },
    series: Array.from({ length: 12 }, (_, i) => ({ ts: ago((12 - i) * HOUR), status: 'ok', metric: base ? Math.round(base * (0.8 + ((i * 7) % 5) / 10)) : null })),
    thresholds: { warn: null, crit: null, unit, worse: 'higher' },
  };
}

/** GET /api/probes (scheduler contract, see apps/web/src/ops/schedules.ts). */
export const PROBES = {
  items: [
    probe('probes.portal-readiness', 'AdminForge readiness', 'http', 'ok', 42, 'ms', null),
    probe('probes.entra-openid-metadata', 'Entra ID sign-in endpoint', 'http', 'ok', 118, 'ms', null),
    probe('probes.graph-reachability', 'Microsoft Graph reachability', 'graph', 'ok', 182, 'ms', null),
    probe('probes.arm-reachability', 'Azure Resource Manager reachability', 'arm', 'warn', 1840, 'ms', 'Latency 1.8 s is above the 1.5 s warning threshold.', 900),
    probe('probes.arm-subscription-access', 'Default subscription access', 'arm', 'ok', 240, 'ms', null),
    probe('probes.m365-service-health', 'Microsoft 365 service health API', 'graph', 'ok', 310, 'ms', null),
    probe('probes.token-graph', 'Token acquisition — Microsoft Graph', 'tokenAcquisition', 'ok', 95, 'ms', null),
    probe('probes.token-arm', 'Token acquisition — Azure Resource Manager', 'tokenAcquisition', 'ok', 101, 'ms', null),
    probe('probes.token-log-analytics', 'Token acquisition — Log Analytics', 'tokenAcquisition', 'ok', 99, 'ms', null),
    probe(
      'probes.token-exchange',
      'Token acquisition · Exchange Online',
      'tokenAcquisition',
      'crit',
      null,
      'ms',
      'AADSTS7000215: Invalid client secret provided. Rotate the automation identity credential, then run the probe again.',
    ),
    probe('probes.token-teams', 'Token acquisition — Skype and Teams Tenant Admin API', 'tokenAcquisition', 'ok', 120, 'ms', null),
    probe('probes.token-sharepoint-admin', 'Token acquisition — SharePoint admin', 'tokenAcquisition', 'ok', 110, 'ms', null),
    probe('probes.sign-in-health', 'Tenant sign-in failure rate', 'signInHealth', 'ok', 2.1, '%', null),
    probe('probes.sign-in-health-adminforge', 'AdminForge sign-in failure rate', 'signInHealth', 'ok', 0, '%', null),
    probe('probes.licence-seats-spe-e3', 'Licence seats — Microsoft 365 E3', 'licenseThreshold', 'warn', 91, '%', '91% of seats assigned (warning at 90%).', 88),
    probe('probes.licence-seats-spe-e5', 'Licence seats — Microsoft 365 E5', 'licenseThreshold', 'ok', 72, '%', null),
    probe('probes.portal-tls-certificate', 'AdminForge TLS certificate', 'certExpiry', 'ok', 61, 'days', null),
    probe('probes.app-credential-expiry', 'App registration credential expiry', 'appCredentialExpiry', 'crit', 4, 'days', 'The “prod” secret of Example HR Sync expires in 4 days.'),
    probe('probes.dns-mx', 'Mail exchanger (MX) for the primary domain', 'dnsResolve', 'ok', 22, 'ms', null),
    probe('probes.dns-autodiscover', 'Autodiscover record for the primary domain', 'dnsResolve', 'ok', 25, 'ms', null),
    probe('probes.dns-spf', 'SPF record for the primary domain', 'dnsResolve', 'ok', 19, 'ms', null),
    probe('probes.dns-dmarc', 'DMARC record for the primary domain', 'dnsResolve', 'warn', 20, 'ms', 'DMARC policy is p=none; consider quarantine.'),
    probe('probes.function-hr-sync-health', 'HR sync Function App health (example)', 'functionHealth', 'ok', 380, 'ms', null),
  ],
};
