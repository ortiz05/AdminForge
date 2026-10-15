import type { QuerySource } from './contracts';

export interface SourceMeta {
  label: string;
  short: string;
  /** One line under the editor: what it queries and as whom. */
  about: string;
  /** Whether a timespan applies (Resource Graph has no time dimension). */
  timespan: boolean;
  /** Tables offered by the editor's completion list. */
  tables: readonly string[];
  /** Placeholder query for an empty editor. */
  starter: string;
}

export const SOURCE_META: Record<QuerySource, SourceMeta> = {
  resourceGraph: {
    label: 'Azure Resource Graph',
    short: 'Resource Graph',
    about: 'Inventory, configuration and policy state across every subscription you can read.',
    timespan: false,
    tables: [
      'resources',
      'resourcecontainers',
      'securityresources',
      'policyresources',
      'advisorresources',
      'alertsmanagementresources',
      'healthresources',
      'guestconfigurationresources',
      'maintenanceresources',
      'networkresources',
      'patchassessmentresources',
      'kubernetesconfigurationresources',
      'authorizationresources',
    ],
    starter: 'resources\n| summarize count() by type\n| order by count_ desc',
  },
  logAnalytics: {
    label: 'Log Analytics',
    short: 'Log Analytics',
    about:
      'Azure Monitor Logs in one workspace: activity log, sign-in and audit logs, agents, Function Apps.',
    timespan: true,
    tables: [
      'AzureActivity',
      'SigninLogs',
      'AADNonInteractiveUserSignInLogs',
      'AADServicePrincipalSignInLogs',
      'AuditLogs',
      'Heartbeat',
      'Usage',
      'AzureDiagnostics',
      'AzureMetrics',
      'FunctionAppLogs',
      'AppRequests',
      'AppExceptions',
      'Perf',
      'Event',
      'Syslog',
      'Update',
    ],
    starter: 'AzureActivity\n| summarize count() by OperationNameValue\n| top 20 by count_',
  },
  advancedHunting: {
    label: 'Defender advanced hunting',
    short: 'Advanced hunting',
    about: 'Microsoft Defender XDR tables: devices, identities, email and cloud apps (last 30 days).',
    timespan: true,
    tables: [
      'DeviceInfo',
      'DeviceLogonEvents',
      'DeviceProcessEvents',
      'DeviceNetworkEvents',
      'DeviceFileEvents',
      'DeviceRegistryEvents',
      'DeviceEvents',
      'DeviceTvmSoftwareVulnerabilities',
      'AlertInfo',
      'AlertEvidence',
      'IdentityLogonEvents',
      'IdentityInfo',
      'IdentityDirectoryEvents',
      'EmailEvents',
      'EmailAttachmentInfo',
      'EmailUrlInfo',
      'CloudAppEvents',
      'AADSignInEventsBeta',
    ],
    starter: 'DeviceInfo\n| summarize arg_max(Timestamp, *) by DeviceId\n| summarize count() by OSPlatform',
  },
};

export const TIMESPANS = [
  { value: 'PT1H', label: 'Last hour' },
  { value: 'PT6H', label: 'Last 6 hours' },
  { value: 'P1D', label: 'Last 24 hours' },
  { value: 'P7D', label: 'Last 7 days' },
  { value: 'P30D', label: 'Last 30 days' },
  { value: 'query', label: 'Set in query' },
] as const;
export type Timespan = (typeof TIMESPANS)[number]['value'];
export const DEFAULT_TIMESPAN: Timespan = 'P1D';
export const isTimespan = (v: unknown): v is Timespan => TIMESPANS.some((t) => t.value === v);
export const timespanLabel = (v: string | undefined) =>
  TIMESPANS.find((t) => t.value === v)?.label ?? 'Set in query';
