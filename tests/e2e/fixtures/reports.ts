import { FIXED_NOW } from './session';

/**
 * The report catalogue (/reports) in mock mode: synthetic reports, schedules and delivery options (Example Org,
 * example.com; configuration key names only, never addresses). Shapes follow GET /api/reports, GET /api/reports/:key,
 * GET /api/schedules and GET /api/schedules/delivery-options.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(FIXED_NOW + offsetMs).toISOString();

export const REPORT_AREAS = [
  { key: 'identity', label: 'Identity', icon: 'identification-card' },
  { key: 'm365', label: 'Microsoft 365', icon: 'squares-four' },
  { key: 'endpoint', label: 'Endpoint', icon: 'devices' },
  { key: 'security', label: 'Security', icon: 'shield-check' },
  { key: 'azure', label: 'Azure', icon: 'cloud' },
];

type Param = {
  name: string;
  type: string;
  label: string;
  description?: string | null;
  default?: unknown;
  required?: boolean;
  multiple?: boolean;
  values?: Array<{ value: string | number | boolean; label: string }> | null;
  min?: number | null;
  max?: number | null;
  schedulable: boolean;
};

const param = (p: Param) => ({
  description: null,
  default: null,
  required: false,
  multiple: false,
  values: null,
  min: null,
  max: null,
  ...p,
});

const days = (def: number, values = [30, 90, 180, 365]) =>
  param({
    name: 'days',
    type: 'enum',
    label: 'Inactive for at least',
    default: def,
    values: values.map((v) => ({ value: v, label: v === 365 ? '1 year' : `${v} days` })),
    schedulable: true,
  });

interface ReportFixture {
  key: string;
  title: string;
  summary: string | null;
  tags: string[];
  owner: string;
  version: string;
  icon: string | null;
  requires: {
    licences: string[];
    entraRoles: string[];
    portalRoles: string[];
    scopes: Record<string, string[]>;
  };
  badge: string | null;
  exportFormats: string[];
  params: ReturnType<typeof param>[];
}

const graph = (...scopes: string[]) => ({ graph: scopes });

export const REPORTS: ReportFixture[] = [
  {
    key: 'identity.app-credential-expiry',
    title: 'App credential expiry',
    summary: 'Client secrets and certificates of app registrations that expire soon or already have.',
    tags: ['identity', 'apps', 'credentials'],
    owner: 'identity-team',
    version: '1.1.0',
    icon: 'key',
    requires: {
      licences: [],
      entraRoles: ['Application Administrator'],
      portalRoles: ['Portal.Reader'],
      scopes: graph('Application.Read.All'),
    },
    badge: null,
    exportFormats: ['csv', 'xlsx'],
    params: [days(30, [30, 60, 90])].map((p) => ({ ...p, label: 'Expiring within' })),
  },
  {
    key: 'identity.inactive-guests',
    title: 'Inactive guests',
    summary: 'Guest accounts with no sign-in for the chosen number of days. Candidates for removal.',
    tags: ['identity', 'guests', 'hygiene', 'report'],
    owner: 'identity-team',
    version: '1.0.0',
    icon: 'user-switch',
    requires: {
      licences: [],
      entraRoles: ['Reports Reader'],
      portalRoles: ['Portal.Reader'],
      scopes: graph('User.Read.All', 'AuditLog.Read.All'),
    },
    badge: null,
    exportFormats: ['csv', 'xlsx'],
    params: [days(90)],
  },
  {
    key: 'identity.inactive-users',
    title: 'Inactive users',
    summary:
      'Enabled member accounts with no successful sign-in for the chosen number of days, including accounts that never signed in.',
    tags: ['identity', 'users', 'hygiene', 'report'],
    owner: 'identity-team',
    version: '1.0.0',
    icon: 'clock-user',
    requires: {
      licences: ['signInLogs'],
      entraRoles: ['Reports Reader'],
      portalRoles: ['Portal.Reader'],
      scopes: graph('User.Read.All', 'AuditLog.Read.All'),
    },
    badge: 'Requires Entra P1',
    exportFormats: ['csv', 'xlsx'],
    params: [
      days(90),
      param({
        name: 'includeDisabled',
        type: 'boolean',
        label: 'Include accounts already blocked',
        default: false,
        schedulable: true,
      }),
      param({
        name: 'licensedOnly',
        type: 'boolean',
        label: 'Licensed accounts only',
        default: false,
        schedulable: true,
      }),
    ],
  },
  {
    key: 'identity.users-without-mfa',
    title: 'Users without MFA',
    summary:
      'Members with no registered multifactor method, from the authentication methods registration report.',
    tags: ['identity', 'mfa', 'report', 'security'],
    owner: 'identity-team',
    version: '1.0.0',
    icon: 'shield-warning',
    requires: {
      licences: ['entraP1'],
      entraRoles: ['Reports Reader'],
      portalRoles: ['Portal.Reader'],
      scopes: graph('AuditLog.Read.All'),
    },
    badge: 'Requires Entra P1',
    exportFormats: ['csv', 'xlsx'],
    params: [],
  },
  {
    key: 'm365.licence-utilization',
    title: 'Licence utilization',
    summary: 'Seats bought, assigned and free for every subscribed SKU.',
    tags: ['m365', 'licensing', 'cost'],
    owner: 'm365-team',
    version: '1.0.0',
    icon: 'identification-badge',
    requires: {
      licences: [],
      entraRoles: ['Global Reader'],
      portalRoles: ['Portal.Reader'],
      scopes: graph('Organization.Read.All'),
    },
    badge: null,
    exportFormats: ['csv', 'xlsx'],
    params: [],
  },
  {
    key: 'm365.mailbox-storage',
    title: 'Mailbox storage and inactive mailboxes',
    summary: 'Mailbox sizes against quota and mailboxes with no activity in 90 days.',
    tags: ['m365', 'exchange', 'usage', 'storage', 'hygiene', 'report'],
    owner: 'm365-team',
    version: '1.0.0',
    icon: 'tray',
    requires: {
      licences: ['exchange'],
      entraRoles: ['Reports Reader'],
      portalRoles: ['Portal.Reader'],
      scopes: graph('Reports.Read.All'),
    },
    badge: null,
    exportFormats: ['csv', 'xlsx'],
    params: [
      param({
        name: 'mailbox',
        type: 'user',
        label: 'Mailbox',
        description: 'One mailbox instead of all.',
        schedulable: false,
      }),
    ],
  },
  {
    key: 'endpoint.stale-devices',
    title: 'Stale devices',
    summary: 'Managed devices that haven’t checked in with Intune for the chosen number of days.',
    tags: ['endpoint', 'devices', 'hygiene', 'report'],
    owner: 'endpoint-team',
    version: '1.0.0',
    icon: 'clock-counter-clockwise',
    requires: {
      licences: ['intune'],
      entraRoles: ['Intune Administrator'],
      portalRoles: ['Portal.Reader'],
      scopes: graph('DeviceManagementManagedDevices.Read.All'),
    },
    badge: 'Requires INTUNE_A or EMS',
    exportFormats: ['csv', 'xlsx'],
    params: [
      param({
        name: 'staleDays',
        type: 'number',
        label: 'No check-in for (days)',
        default: 90,
        min: 30,
        max: 365,
        schedulable: true,
      }),
      param({
        name: 'platform',
        type: 'enum',
        label: 'Platforms',
        multiple: true,
        default: [],
        values: [
          { value: 'windows', label: 'Windows' },
          { value: 'macOS', label: 'macOS' },
          { value: 'iOS', label: 'iOS' },
          { value: 'android', label: 'Android' },
        ],
        schedulable: true,
      }),
    ],
  },
  {
    key: 'security.secure-score-summary',
    title: 'Secure Score trend and top improvement actions',
    summary: 'The tenant’s Secure Score over time and the actions that would raise it most.',
    tags: ['security', 'secure-score', 'posture', 'report'],
    owner: 'security-team',
    version: '1.0.0',
    icon: 'shield-check',
    requires: {
      licences: [],
      entraRoles: ['Security Reader'],
      portalRoles: ['Portal.Reader'],
      scopes: graph('SecurityEvents.Read.All'),
    },
    badge: null,
    exportFormats: ['csv', 'xlsx'],
    params: [
      param({
        name: 'period',
        type: 'dateRange',
        label: 'Period',
        default: 'P30D',
        schedulable: false,
      }),
    ],
  },
  {
    key: 'azure.budgets',
    title: 'Azure budgets',
    summary: 'Budgets per subscription with spend to date and forecast. Shown as charts only.',
    tags: ['azure', 'cost', 'budgets', 'governance'],
    owner: 'azure-team',
    version: '1.0.0',
    icon: 'piggy-bank',
    requires: {
      licences: [],
      entraRoles: [],
      portalRoles: ['Portal.Reader'],
      scopes: { arm: ['user_impersonation'] },
    },
    badge: null,
    exportFormats: [],
    params: [],
  },
  {
    key: 'azure.untagged-resources',
    title: 'Untagged Azure resources',
    summary: 'Resources missing a required tag, by subscription and resource group.',
    tags: ['azure', 'governance', 'tags', 'cost'],
    owner: 'azure-team',
    version: '1.0.0',
    icon: 'tag',
    requires: {
      licences: [],
      entraRoles: [],
      portalRoles: ['Portal.Reader'],
      scopes: { arm: ['user_impersonation'] },
    },
    badge: null,
    exportFormats: ['csv', 'xlsx'],
    params: [
      param({
        name: 'requiredTag',
        type: 'string',
        label: 'Required tag',
        default: 'CostCenter',
        schedulable: true,
      }),
    ],
  },
];

/** What GET /api/reports/:key adds: the columns an export contains. */
export const REPORT_COLUMNS: Record<string, Array<{ field: string; label: string }>> = {
  'identity.inactive-users': [
    { field: 'displayName', label: 'Name' },
    { field: 'userPrincipalName', label: 'User principal name' },
    { field: 'department', label: 'Department' },
    { field: 'lastSignIn', label: 'Last sign-in' },
    { field: 'daysInactive', label: 'Days inactive' },
    { field: 'licensed', label: 'Licensed' },
    { field: 'source', label: 'Source' },
  ],
};
export const DEFAULT_COLUMNS = [
  { field: 'displayName', label: 'Name' },
  { field: 'id', label: 'Object ID' },
  { field: 'status', label: 'Status' },
];

export const DELIVERY_OPTIONS = {
  email: {
    available: true,
    lists: [
      { key: 'AF_REPORT_RECIPIENTS', label: 'Report recipients' },
      { key: 'AF_SERVICE_DESK_EMAIL', label: 'Service desk email' },
    ],
  },
  teams: {
    lists: [
      { key: 'AF_TEAMS_ALERTS_WEBHOOK', label: 'Teams alerts' },
      { key: 'AF_TEAMS_REPORTS_WEBHOOK', label: 'Teams reports' },
    ],
  },
};

export interface ScheduleFixture {
  key: string;
  title: string;
  summary: string | null;
  cron: string;
  cronText: string | null;
  timezone: string;
  enabled: boolean;
  identity: 'automation';
  job: { kind: 'report'; ref: string; params?: Record<string, unknown> };
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  writeCapable: false;
  approvedBy: string[];
  source: 'content' | 'portal';
  pendingApprovalId: string | null;
  createdBy: string | null;
  canManage: boolean;
  delivery: Array<Record<string, unknown>>;
  notify: Array<Record<string, unknown>>;
}

const schedule = (s: Partial<ScheduleFixture> & Pick<ScheduleFixture, 'key' | 'title' | 'cron' | 'job'>) =>
  ({
    summary: null,
    cronText: null,
    timezone: 'UTC',
    enabled: true,
    identity: 'automation',
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    writeCapable: false,
    approvedBy: [],
    source: 'content',
    pendingApprovalId: null,
    createdBy: null,
    canManage: false,
    delivery: [{ type: 'file', format: 'xlsx', retain: 26 }],
    notify: [],
    ...s,
  }) as ScheduleFixture;

export const PORTAL_SCHEDULE_KEY = 'portal.identity-inactive-users-3f9a2c';

/** Content and portal schedules of the catalogue's reports (Thursday 15 Oct 2026, 14:00 UTC is "now"). */
export function reportSchedules(): ScheduleFixture[] {
  return [
    schedule({
      key: 'reports.app-credential-expiry',
      title: 'Weekly app credential expiry report',
      cron: '0 7 * * 1',
      job: { kind: 'report', ref: 'identity.app-credential-expiry' },
      nextRunAt: at(3 * DAY + 17 * HOUR),
      lastRunAt: at(-3 * DAY - 7 * HOUR),
      lastStatus: 'succeeded',
    }),
    schedule({
      key: 'reports.inactive-users-weekly',
      title: 'Inactive users for the service desk',
      cron: '0 7 * * 1',
      job: { kind: 'report', ref: 'identity.inactive-users' },
      nextRunAt: at(3 * DAY + 17 * HOUR),
      lastRunAt: at(-3 * DAY - 7 * HOUR),
      lastStatus: 'succeeded',
    }),
    schedule({
      key: PORTAL_SCHEDULE_KEY,
      title: 'Inactive users, weekdays',
      cron: '30 6 * * 1-5',
      timezone: 'Europe/London',
      job: { kind: 'report', ref: 'identity.inactive-users', params: { days: 30 } },
      nextRunAt: at(DAY - 8.5 * HOUR),
      lastRunAt: at(-8.5 * HOUR),
      lastStatus: 'succeeded',
      source: 'portal',
      createdBy: 'mock.engineer@example.com',
      canManage: true,
      delivery: [
        { type: 'file', format: 'xlsx', retain: 26 },
        { type: 'email', key: 'AF_REPORT_RECIPIENTS', label: 'Report recipients', format: 'xlsx' },
      ],
      notify: [{ type: 'teams', key: 'AF_TEAMS_ALERTS_WEBHOOK', label: 'Teams alerts' }],
    }),
    schedule({
      key: 'portal.m365-mailbox-storage-a1b2c3',
      title: 'Mailbox storage, monthly',
      cron: '0 8 1 * *',
      job: { kind: 'report', ref: 'm365.mailbox-storage' },
      nextRunAt: at(16 * DAY + 18 * HOUR),
      lastRunAt: at(-14 * DAY - 6 * HOUR),
      lastStatus: 'failed',
      source: 'portal',
      createdBy: 'a.lee@example.com',
      canManage: false,
    }),
    schedule({
      key: 'portal.azure-untagged-resources-9d8e7f',
      title: 'Untagged Azure resources, weekly',
      cron: '0 9 * * 5',
      enabled: false,
      job: { kind: 'report', ref: 'azure.untagged-resources', params: { requiredTag: 'Owner' } },
      lastRunAt: at(-20 * DAY - 5 * HOUR),
      lastStatus: 'succeeded',
      source: 'portal',
      createdBy: 'mock.engineer@example.com',
      canManage: true,
    }),
  ];
}

/** Run history: the newest file of the portal Inactive users schedule. */
export function reportScheduleRuns(key: string) {
  if (key !== PORTAL_SCHEDULE_KEY) return { items: [] };
  return {
    items: [
      {
        id: 'sr-iu-2',
        trigger: 'cron',
        status: 'succeeded',
        startedAt: at(-8.5 * HOUR),
        endedAt: at(-8.5 * HOUR + 41_000),
        artifact: {
          name: 'inactive-users-2026-10-15.xlsx',
          href: `/api/schedules/${PORTAL_SCHEDULE_KEY}/artifacts/sr-iu-2`,
          size: 61_440,
        },
      },
    ],
  };
}
