/**
 * Representative parameters per page for the perf suite: entity pages get the heaviest realistic subject (the
 * 100k-member All Company group, the SKU half the tenant holds, a team, a device…); list pages keep their defaults
 * (unfiltered, the expensive case). Pages that read Azure or the PowerShell runner get syntactically valid values; the
 * fake Graph doesn't model those services and the report lists them as such.
 */
import type { SyntheticTenant } from '../tenant/generate';
import { ROLE_TEMPLATES } from '../tenant/generate';

export function representativeParams(key: string, t: SyntheticTenant): Record<string, unknown> {
  const sub = '00000000-0000-4000-8000-00000000a2a2';
  const signIn = t.signIns.at(100);
  const member = t.users.findIndex((u, i) => i > 1000 && u.userType === 'Member' && t.managerOf[i]! >= 0);
  const entity: Record<string, Record<string, unknown>> = {
    'identity.user': { id: t.users[member]!.id },
    'identity.group': { id: t.groups[t.allCompany]!.id },
    'identity.device': { id: t.entraDevices[0]!.id },
    'identity.app-registration': { id: t.applications[0]!.id },
    'identity.enterprise-app': { id: t.servicePrincipals[3]!.id },
    'identity.role': { id: ROLE_TEMPLATES[0]![0] },
    'identity.sign-in': { id: signIn.id, at: signIn.createdDateTime },
    'identity.ca-policy': { id: t.caPolicies[0]!.id },
    'endpoint.device': { id: t.managedDevices[0]!.id },
    'endpoint.compliance-policy': { id: t.compliancePolicies[0]!.id },
    'endpoint.configuration-profile': { id: t.deviceConfigurations[0]!.id },
    'm365.licence': { skuId: t.subscribedSkus[1]!.skuId },
    'm365.team': { id: t.groups[t.teams[0]!]!.id },
    'm365.sharepoint-site': { id: t.sites.at(0).id },
    'm365.message': { id: t.serviceMessages[0]!.id },
    'm365.service-issue': { id: t.serviceIssues[0]!.id },
    'security.risky-user': { id: t.riskyUsers[0]!.id },
    'm365.distribution-list': { address: 'all-staff@example.com' },
    'm365.mailbox': { mailbox: t.users[member]!.mail },
    'azure.subscription': { id: sub },
    'azure.function-app': { subscriptionId: sub, resourceGroup: 'rg-apps', name: 'func-hr-sync' },
    'azure.arc-server': {
      id: `/subscriptions/${sub}/resourceGroups/rg-arc/providers/Microsoft.HybridCompute/machines/arc-01`,
    },
    'azure.resource': {
      id: `/subscriptions/${sub}/resourceGroups/rg-apps/providers/Microsoft.Web/sites/web-01`,
    },
  };
  return entity[key] ?? {};
}

/** Values for `${ env.X }` in content (config/example.env keys), synthetic. */
export const PERF_ENV: Record<string, string> = {
  AF_TENANT_ID: '00000000-0000-4000-8000-00000000e0e0',
  AF_PRIMARY_DOMAIN: 'example.com',
  AF_MAIL_DOMAIN: 'example.com',
  AF_SPO_TENANT_NAME: 'example',
  AF_SUBSCRIPTION_ID: '00000000-0000-4000-8000-00000000a2a2',
  AF_LOG_ANALYTICS_WORKSPACE_ID: '00000000-0000-4000-8000-00000000a3a3',
  AF_READ_CLIENT_ID: '00000000-0000-4000-8000-00000000a4a4',
  AF_REPORT_RECIPIENTS: 'reports@example.com',
  AF_LICENCE_SKU_1: 'SPE_E5',
  AF_LICENCE_SKU_2: 'SPE_E3',
  PUBLIC_BASE_URL: 'https://adminforge.example.com',
};
