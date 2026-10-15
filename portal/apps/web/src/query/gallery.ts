import type { QuerySource } from './contracts';

/** Suggested chart for a starter query (x / y column names, optional series split). */
export interface ChartHint {
  kind: 'bar' | 'line' | 'area';
  x: string;
  y: string;
  split?: string;
}

export interface StarterQuery {
  id: string;
  source: QuerySource;
  title: string;
  description: string;
  query: string;
  chart?: ChartHint;
}

/**
 * Starter queries per source. Each is read-only, bounded (top / summarize), and uses only documented tables
 * and columns so it runs unchanged in any tenant. Log Analytics queries need the matching diagnostic settings.
 */
export const GALLERY: readonly StarterQuery[] = [
  // ── Azure Resource Graph ──────────────────────────────────────────────────
  {
    id: 'arg.inventory',
    source: 'resourceGraph',
    title: 'Inventory by type and region',
    description: 'How many resources of each type you run, per Azure region.',
    query: `resources
| summarize resources = count() by type, location
| order by resources desc`,
    chart: { kind: 'bar', x: 'type', y: 'resources', split: 'location' },
  },
  {
    id: 'arg.untagged',
    source: 'resourceGraph',
    title: 'Untagged resources',
    description: 'Top-level resources with no tags at all, so cost and ownership can be assigned.',
    query: `resources
| where type !endswith '/extensions' and array_length(split(type, '/')) == 2
| where isnull(tags) or array_length(bag_keys(tags)) == 0
| project name, type, resourceGroup, location, subscriptionId, id
| order by type asc, name asc`,
  },
  {
    id: 'arg.public-storage',
    source: 'resourceGraph',
    title: 'Storage accounts open to the public',
    description: 'Anonymous blob access allowed, or the firewall accepts every network.',
    query: `resources
| where type =~ 'microsoft.storage/storageaccounts'
| extend allowBlobPublicAccess = tobool(properties.allowBlobPublicAccess),
    publicNetworkAccess = tostring(properties.publicNetworkAccess),
    defaultAction = tostring(properties.networkAcls.defaultAction),
    minimumTlsVersion = tostring(properties.minimumTlsVersion)
| where allowBlobPublicAccess == true or (publicNetworkAccess != 'Disabled' and defaultAction =~ 'Allow')
| project name, allowBlobPublicAccess, publicNetworkAccess, defaultAction, minimumTlsVersion, resourceGroup, location, subscriptionId, id`,
  },
  {
    id: 'arg.nsg-open-ports',
    source: 'resourceGraph',
    title: 'NSG rules open to the internet',
    description: 'Inbound allow rules whose source is any address — management ports first.',
    query: `resources
| where type =~ 'microsoft.network/networksecuritygroups'
| mv-expand securityRule = properties.securityRules
| extend access = tostring(securityRule.properties.access),
    direction = tostring(securityRule.properties.direction),
    sourcePrefix = tostring(securityRule.properties.sourceAddressPrefix),
    ports = iff(isnotempty(securityRule.properties.destinationPortRange), tostring(securityRule.properties.destinationPortRange), strcat_array(securityRule.properties.destinationPortRanges, ',')),
    priority = toint(securityRule.properties.priority)
| where access =~ 'Allow' and direction =~ 'Inbound' and sourcePrefix in ('*', '0.0.0.0/0', 'Internet', 'Any')
| extend managementPort = ports == '*' or ports has '22' or ports has '3389'
| project nsg = name, rule = tostring(securityRule.name), ports, managementPort, priority, resourceGroup, subscriptionId, id
| order by managementPort desc, priority asc`,
  },
  {
    id: 'arg.arc-disconnected',
    source: 'resourceGraph',
    title: 'Disconnected Azure Arc servers',
    description: 'Arc-enabled machines that are not connected, longest silent first.',
    query: `resources
| where type =~ 'microsoft.hybridcompute/machines'
| extend status = tostring(properties.status),
    lastStatusChange = todatetime(properties.lastStatusChange),
    agentVersion = tostring(properties.agentVersion),
    osName = tostring(properties.osName)
| where status != 'Connected'
| extend hoursNotConnected = datetime_diff('hour', now(), lastStatusChange)
| project name, status, lastStatusChange, hoursNotConnected, agentVersion, osName, resourceGroup, subscriptionId, id
| order by hoursNotConnected desc`,
  },
  {
    id: 'arg.policy-noncompliance',
    source: 'resourceGraph',
    title: 'Policy non-compliance',
    description: 'Policy assignments and definitions with the most non-compliant resources.',
    query: `policyresources
| where type =~ 'microsoft.policyinsights/policystates'
| where tostring(properties.complianceState) =~ 'NonCompliant'
| summarize nonCompliantResources = dcount(tostring(properties.resourceId)) by policyAssignment = tostring(properties.policyAssignmentName), policyDefinition = tostring(properties.policyDefinitionName)
| top 50 by nonCompliantResources desc`,
    chart: { kind: 'bar', x: 'policyDefinition', y: 'nonCompliantResources' },
  },
  {
    id: 'arg.defender-recommendations',
    source: 'resourceGraph',
    title: 'Defender for Cloud recommendations',
    description: 'Unhealthy assessments by recommendation and severity.',
    query: `securityresources
| where type =~ 'microsoft.security/assessments'
| where tostring(properties.status.code) =~ 'Unhealthy'
| summarize unhealthy = count() by recommendation = tostring(properties.displayName), severity = tostring(properties.metadata.severity)
| top 50 by unhealthy desc`,
  },
  {
    id: 'arg.vm-power',
    source: 'resourceGraph',
    title: 'Virtual machines by power state',
    description: 'Running, deallocated and stopped VMs by size — stopped-but-allocated VMs still cost money.',
    query: `resources
| where type =~ 'microsoft.compute/virtualmachines'
| extend powerState = tostring(properties.extended.instanceView.powerState.displayStatus),
    vmSize = tostring(properties.hardwareProfile.vmSize)
| summarize vms = count() by powerState, vmSize
| order by vms desc`,
    chart: { kind: 'bar', x: 'vmSize', y: 'vms', split: 'powerState' },
  },

  // ── Log Analytics ─────────────────────────────────────────────────────────
  {
    id: 'la.connection-check',
    source: 'logAnalytics',
    title: 'Workspace connection check',
    description: 'Answers immediately, even in an empty workspace — confirms access before you dig in.',
    query: `print workspace = 'reachable', checkedAt = now()`,
  },
  {
    id: 'la.signin-failures',
    source: 'logAnalytics',
    title: 'Sign-in failures by app',
    description:
      'Failed Entra sign-ins by application and reason. Needs sign-in logs exported (Entra ID P1).',
    query: `SigninLogs
| where ResultType != '0'
| summarize failures = count(), users = dcount(UserPrincipalName) by AppDisplayName, ResultType, ResultDescription
| top 25 by failures desc`,
    chart: { kind: 'bar', x: 'AppDisplayName', y: 'failures' },
  },
  {
    id: 'la.signin-failures-trend',
    source: 'logAnalytics',
    title: 'Sign-in failures over time',
    description: 'Hourly failed sign-ins for the five noisiest apps.',
    query: `SigninLogs
| where ResultType != '0'
| summarize failures = count() by bin(TimeGenerated, 1h), AppDisplayName
| order by TimeGenerated asc`,
    chart: { kind: 'line', x: 'TimeGenerated', y: 'failures', split: 'AppDisplayName' },
  },
  {
    id: 'la.activity-failed-writes',
    source: 'logAnalytics',
    title: 'Failed Azure writes (AzureActivity)',
    description: 'Create, update, delete and action calls that failed — who tried, on what, and why.',
    query: `AzureActivity
| where ActivityStatusValue =~ 'Failure'
| where OperationNameValue endswith '/write' or OperationNameValue endswith '/delete' or OperationNameValue endswith '/action'
| project TimeGenerated, Caller, OperationNameValue, ActivitySubstatusValue, ResourceGroup, ResourceId = _ResourceId, CorrelationId
| top 200 by TimeGenerated desc`,
  },
  {
    id: 'la.activity-changes',
    source: 'logAnalytics',
    title: 'Azure changes by caller',
    description: 'Successful writes and deletes per hour, split by who made them.',
    query: `AzureActivity
| where CategoryValue == 'Administrative' and ActivityStatusValue =~ 'Success'
| where OperationNameValue endswith '/write' or OperationNameValue endswith '/delete'
| summarize changes = count() by bin(TimeGenerated, 1h), Caller
| order by TimeGenerated asc`,
    chart: { kind: 'area', x: 'TimeGenerated', y: 'changes', split: 'Caller' },
  },
  {
    id: 'la.ingestion',
    source: 'logAnalytics',
    title: 'Billable ingestion by table',
    description: 'Which tables drive the workspace bill.',
    query: `Usage
| where IsBillable == true
| summarize billableGB = round(sum(Quantity) / 1000, 3) by DataType
| order by billableGB desc`,
    chart: { kind: 'bar', x: 'DataType', y: 'billableGB' },
  },
  {
    id: 'la.heartbeat',
    source: 'logAnalytics',
    title: 'Machines missing heartbeats',
    description: 'Agents that have not reported for more than 15 minutes.',
    query: `Heartbeat
| summarize lastHeartbeat = max(TimeGenerated) by Computer, OSType, Category
| extend minutesSince = datetime_diff('minute', now(), lastHeartbeat)
| where minutesSince > 15
| order by minutesSince desc`,
  },
  {
    id: 'la.audit-operations',
    source: 'logAnalytics',
    title: 'Directory changes by service',
    description: 'Entra audit events by service, operation and result.',
    query: `AuditLogs
| summarize events = count() by LoggedByService, OperationName, Result
| top 25 by events desc`,
  },

  // ── Defender advanced hunting ─────────────────────────────────────────────
  {
    id: 'ah.devices-by-os',
    source: 'advancedHunting',
    title: 'Devices by platform',
    description: 'Latest record per device, counted by OS platform and onboarding state.',
    query: `DeviceInfo
| summarize arg_max(Timestamp, *) by DeviceId
| summarize devices = count() by OSPlatform, OnboardingStatus
| order by devices desc`,
    chart: { kind: 'bar', x: 'OSPlatform', y: 'devices', split: 'OnboardingStatus' },
  },
  {
    id: 'ah.alerts',
    source: 'advancedHunting',
    title: 'Alerts by severity and source',
    description: 'Defender alerts grouped by severity and the product that raised them.',
    query: `AlertInfo
| summarize alerts = count() by Severity, ServiceSource
| order by alerts desc`,
    chart: { kind: 'bar', x: 'ServiceSource', y: 'alerts', split: 'Severity' },
  },
  {
    id: 'ah.device-logon-failures',
    source: 'advancedHunting',
    title: 'Failed logons by device',
    description: 'Devices with the most failed logons and how many accounts were tried.',
    query: `DeviceLogonEvents
| where ActionType == 'LogonFailed'
| summarize failures = count(), accounts = dcount(AccountName) by DeviceName
| top 25 by failures desc`,
  },
  {
    id: 'ah.identity-logon-failures',
    source: 'advancedHunting',
    title: 'Identity logon failures',
    description: 'Defender for Identity: failed logons by account, application and reason.',
    query: `IdentityLogonEvents
| where ActionType == 'LogonFailed'
| summarize failures = count() by AccountUpn, Application, FailureReason
| top 25 by failures desc`,
  },
  {
    id: 'ah.delivered-threats',
    source: 'advancedHunting',
    title: 'Delivered phishing and malware',
    description: 'Email flagged as phish or malware that still reached a mailbox.',
    query: `EmailEvents
| where ThreatTypes has_any ('Phish', 'Malware') and DeliveryAction == 'Delivered'
| project Timestamp, RecipientEmailAddress, SenderFromAddress, Subject, ThreatTypes, DeliveryLocation
| top 200 by Timestamp desc`,
  },
  {
    id: 'ah.critical-vulnerabilities',
    source: 'advancedHunting',
    title: 'Critical vulnerabilities by software',
    description: 'Software with critical CVEs, by the number of exposed devices.',
    query: `DeviceTvmSoftwareVulnerabilities
| where VulnerabilitySeverityLevel == 'Critical'
| summarize devices = dcount(DeviceId), cves = dcount(CveId) by SoftwareVendor, SoftwareName
| top 25 by devices desc`,
  },
];

export const galleryFor = (source: QuerySource) => GALLERY.filter((q) => q.source === source);
export const findStarter = (query: string, source: QuerySource) =>
  GALLERY.find((q) => q.source === source && q.query.trim() === query.trim());
