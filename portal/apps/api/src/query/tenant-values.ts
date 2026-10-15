import type { AppContext } from '../context';
import type { TenantValue } from './scaffold';

/** This installation's configured ids and domains: scaffolded YAML must never contain them (R2). */
export function tenantValuesFor(
  ctx: AppContext,
  session: { tenantId: string; tenantDomain: string },
): TenantValue[] {
  const c = ctx.config;
  const env = ctx.contentEnv();
  const list: Array<[string, unknown]> = [
    ['the tenant id', c.AF_TENANT_ID],
    ['the tenant id', session.tenantId],
    ['the default subscription id', c.AF_SUBSCRIPTION_ID],
    ['the primary domain', c.AF_PRIMARY_DOMAIN],
    ['the tenant domain', session.tenantDomain],
    ['the Log Analytics workspace id', env.AF_LOG_ANALYTICS_WORKSPACE_ID],
    ['an AdminForge app client id', c.AF_READ_CLIENT_ID],
    ['an AdminForge app client id', c.AF_WRITE_CLIENT_ID],
    ['the automation identity client id', c.AF_AUTOMATION_CLIENT_ID],
    ['the SharePoint tenant name', c.AF_SPO_TENANT_NAME],
  ];
  return list
    .filter((x): x is [string, string] => typeof x[1] === 'string' && x[1].trim() !== '')
    .map(([kind, value]) => ({ kind, value }));
}
