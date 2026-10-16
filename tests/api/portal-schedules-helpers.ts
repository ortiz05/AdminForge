/**
 * The Reports catalogue and portal (in-app) report schedules harness: synthetic report definitions (an Entra report
 * with every parameter type, an Operator-only cost report, a draft and an invalid one), navigation, a content
 * schedule, delivery configuration (`DELIVERY_ENV`: key names the API shows, synthetic values), a valid
 * POST /api/schedules `body()` and `portalApp()` — `schedulesApp` (schedules-helpers.ts) over those fixtures, with
 * `/subscribedSkus` answered by `skus` for licence checks.
 *
 * Used by the portal-schedules-* and reports-catalog API tests. People and role sets come from support/people.ts
 * (re-exported here).
 */
import { Report, type Navigation } from '@adminforge/schemas';
import {
  FakeDefinitions,
  FakeJobs,
  FakeOutbound,
  schedule,
  schedulesApp,
  type SchedulesAppOptions,
} from './schedules-helpers';

export { ADMIN, ALL_ROLES, AVERY, BLAKE, DANA, OPERATOR, READER } from './support/people';

// Synthetic content and configuration for the Reports catalogue and in-app report schedules (Example Org).
export const inactiveUsers = Report.parse({
  kind: 'report',
  id: 'identity.inactive-users',
  version: '1.2.0',
  title: 'Inactive users',
  summary: 'Accounts that have not signed in for a while.',
  owner: 'identity-team',
  tags: ['identity', 'users', 'report'],
  nav: { section: 'reports', icon: 'user-minus', order: 10 },
  requires: {
    portalRoles: ['Portal.Reader'],
    scopes: { graph: ['User.Read.All', 'AuditLog.Read.All'] },
    entraRoles: ['Reports Reader'],
    licences: ['AAD_PREMIUM'],
  },
  params: {
    days: {
      type: 'enum',
      label: 'Inactive for',
      default: 30,
      values: [
        { value: 30, label: '30 days' },
        { value: 90, label: '90 days' },
      ],
    },
    includeGuests: { type: 'boolean', label: 'Include guests', default: false },
    top: { type: 'number', label: 'Rows', min: 1, max: 500, default: '${ 100 }' },
    department: { type: 'string', label: 'Department', description: 'Exact department name.' },
    manager: { type: 'string', label: 'Manager', picker: 'user' },
    since: { type: 'date', label: 'Since', default: '-30d' },
    id: { type: 'string', hidden: true },
  },
  datasources: { users: { source: 'graph', request: { path: '/users' } } },
  layout: [
    {
      widget: 'table',
      id: 'users',
      data: 'users.value',
      columns: [
        { field: 'displayName', label: 'Name' },
        { field: 'userPrincipalName', label: 'Sign-in name' },
        { field: 'id', label: 'Object id', hidden: true },
      ],
    },
  ],
  export: { formats: ['csv', 'xlsx'] },
});

/** Operators only (application-permission cost data). */
export const monthlyCost = Report.parse({
  kind: 'report',
  id: 'azure.monthly-cost',
  version: '1.0.0',
  title: 'Monthly cost',
  owner: 'cloud-team',
  tags: ['azure', 'cost'],
  nav: { section: 'reports', icon: 'currency-dollar' },
  requires: { portalRoles: ['Portal.Operator'], scopes: { arm: ['user_impersonation'] } },
  datasources: {
    cost: {
      source: 'arm',
      request: { path: '/providers/Microsoft.CostManagement/query', apiVersion: '2023-03-01' },
    },
  },
  layout: [
    { widget: 'table', id: 'cost', data: 'cost.value', columns: [{ field: 'name', label: 'Resource' }] },
  ],
  export: { formats: ['xlsx'] },
});

export const draftReport = { ...inactiveUsers, id: 'identity.draft-report', title: 'Draft', status: 'draft' };

/** Not a valid report (no export) — only the registry fakes can hold one; scheduling it must be refused. */
export const noExport = {
  kind: 'report' as const,
  id: 'security.no-export',
  version: '1.0.0',
  title: 'Alerts overview',
  owner: 'security-team',
  tags: ['security'],
  layout: [],
};

export const navigation: Navigation = {
  kind: 'navigation',
  id: 'portal.navigation',
  version: '1.2.0',
  title: 'Navigation',
  owner: 'portal-admins',
  sections: [
    { key: 'azure', label: 'Azure', icon: 'cloud', order: 60 },
    { key: 'identity', label: 'Identity', icon: 'identification-card', order: 20 },
  ],
};

export const contentSchedule = schedule('reports.inactive-users-weekly', {
  cron: '0 6 * * 1',
  job: {
    kind: 'report',
    ref: 'identity.inactive-users',
    delivery: [
      { type: 'file', format: 'xlsx', retain: 12 },
      { type: 'email', to: ['${ env.AF_REPORT_RECIPIENTS }'] },
    ],
  },
});

/** Delivery configuration (key names are what the API shows; values never leave the server). */
export const DELIVERY_ENV = {
  AF_MAIL_SENDER: 'reports@example.com',
  AF_REPORT_RECIPIENTS: 'it-reports@example.com',
  AF_SECURITY_ALERTS: 'secops@example.com',
  AF_TEAMS_ALERTS_WEBHOOK: 'https://example.webhook.office.com/webhookb2/synthetic',
  AF_EMPTY_RECIPIENTS: '',
};

export function reportDefs() {
  return new FakeDefinitions()
    .set(navigation)
    .set(inactiveUsers)
    .set(monthlyCost)
    .set(draftReport as never)
    .set(noExport as never)
    .set(contentSchedule);
}

/** A valid POST /api/schedules body (override parts per test). */
export function body(over: Record<string, unknown> = {}, job: Record<string, unknown> = {}) {
  return {
    title: 'Inactive users, weekly',
    cron: '0 6 * * 1',
    timezone: 'Europe/London',
    job: { kind: 'report', ref: 'identity.inactive-users', format: 'xlsx', ...job },
    ...over,
  };
}

/** The schedules app with the report fixtures and delivery configuration (sessions also have `put` and `del`). */
export async function portalApp(
  o: SchedulesAppOptions & { env?: Record<string, string>; skus?: unknown } = {},
) {
  const outbound =
    o.outbound ??
    new FakeOutbound((call) => (call.path === '/subscribedSkus' ? (o.skus ?? { value: [] }) : {}));
  return schedulesApp({
    defs: o.defs ?? reportDefs(),
    jobs: o.jobs ?? new FakeJobs(),
    outbound,
    inProcess: o.inProcess ?? false,
    ...(o.config ? { config: o.config } : {}),
    schedules: { delivery: { env: o.env ?? DELIVERY_ENV }, ...o.schedules },
  });
}
