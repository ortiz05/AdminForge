/**
 * What each planned page will do (Appendix A + R8). The "Coming soon" page explains the page instead of
 * leaving a dead link. Looked up by nav key, then by the last path segment.
 */
export interface PlannedPage {
  summary: string;
  capabilities: string[];
}

export const PLANNED: Record<string, PlannedPage> = {
  users: {
    summary: 'Every user in the directory, with the filters and bulk actions engineers use daily.',
    capabilities: [
      'Filter by type, status, department, licence, and last sign-in',
      'Open any user in the inspector without losing your place',
      'Disable sign-in, revoke sessions, reset MFA, or issue a Temporary Access Pass (armed)',
      'Export the current view to CSV or Excel',
    ],
  },
  groups: {
    summary: 'Security, Microsoft 365 and dynamic groups, and their membership.',
    capabilities: [
      'See owners, members, and dynamic rules',
      'Add or remove members in bulk (armed)',
      'Find empty and ownerless groups',
    ],
  },
  roles: {
    summary: 'Directory roles and Privileged Identity Management.',
    capabilities: [
      'Active and eligible assignments per role',
      'Activate your eligible roles with a justification (armed)',
      'Quarterly access review export',
    ],
  },
  'auth-methods': {
    summary: 'Authentication methods registered by each user.',
    capabilities: [
      'MFA registration coverage',
      'Users without a phishing-resistant method',
      'Reset methods or issue a Temporary Access Pass (armed)',
    ],
  },
  'sign-ins': {
    summary: 'Interactive and non-interactive sign-in logs.',
    capabilities: [
      'Filter by user, app, result, location, and Conditional Access outcome',
      'Jump from a failure to the policy that caused it',
    ],
  },
  audit: {
    summary: 'Every change made through AdminForge, with who, why, and the Microsoft request ID.',
    capabilities: [
      'Filter by person, action, and target',
      'Verify the audit hash chain',
      'Export for security reviews',
    ],
  },
  'audit-logs': {
    summary: 'Microsoft Entra directory audit logs.',
    capabilities: ['Filter by activity, initiator, and target', 'Correlate with AdminForge runs'],
  },
  'enterprise-apps': {
    summary: 'Enterprise applications (service principals) in the tenant.',
    capabilities: [
      'Assignments, owners, and consent grants',
      'Sign-in activity per app',
      'Find apps nobody signs in to',
    ],
  },
  'app-registrations': {
    summary: 'App registrations and their credentials.',
    capabilities: [
      'Secrets and certificates expiring in 30, 60, and 90 days',
      'Owners and API permissions',
      'Rotate a secret through an approved playbook (armed)',
    ],
  },
  'conditional-access': {
    summary: 'Conditional Access policies, read-only.',
    capabilities: [
      'Policy targets, conditions, and grant controls side by side',
      'What-if evaluation for a user and app',
      'Report-only impact',
    ],
  },
  devices: {
    summary: 'Entra and Intune devices in one list.',
    capabilities: [
      'Join type, compliance, OS, and last check-in',
      'Find stale devices',
      'Sync, restart, retire, or wipe (armed, wipe needs approval)',
    ],
  },
  compliance: {
    summary: 'Intune compliance policies and device state.',
    capabilities: ['Non-compliant devices by policy and setting', 'Trends over time'],
  },
  licences: {
    summary: 'Licence subscriptions, assignments, and unassigned seats.',
    capabilities: [
      'Utilisation per SKU and service plan',
      'Users with redundant licences',
      'Assign or remove licences in bulk (armed)',
    ],
  },
  licenses: {
    summary: 'Licence subscriptions, assignments, and unassigned seats.',
    capabilities: [
      'Utilisation per SKU and service plan',
      'Users with redundant licences',
      'Assign or remove licences in bulk (armed)',
    ],
  },
  'service-health': {
    summary: 'Microsoft 365 service health and incidents.',
    capabilities: [
      'Current incidents and advisories per service',
      'Incident history and post-incident reviews',
    ],
  },
  'message-center': {
    summary: 'Microsoft 365 Message center posts.',
    capabilities: ['Filter by service, category, and deadline', 'Mark posts as reviewed for your team'],
  },
  mailboxes: {
    summary: 'Exchange Online mailboxes, shared mailboxes, and permissions.',
    capabilities: [
      'Forwarding rules, including external forwarding',
      'Full Access and Send As permissions',
      'Convert to shared and set auto-replies (armed)',
    ],
  },
  exchange: {
    summary: 'Exchange Online mailboxes, shared mailboxes, permissions, and mail flow.',
    capabilities: [
      'Forwarding rules, including external forwarding',
      'Full Access and Send As permissions',
      'Convert to shared and set auto-replies (armed)',
    ],
  },
  'distribution-lists': {
    summary: 'Distribution lists and mail-enabled security groups.',
    capabilities: ['Members, owners, and delivery restrictions', 'Add or remove members (armed)'],
  },
  teams: {
    summary: 'Microsoft Teams and their owners.',
    capabilities: ['Teams without owners', 'Guest access and archived teams'],
  },
  sharepoint: {
    summary: 'SharePoint sites and OneDrive.',
    capabilities: ['Sites with anyone-links or external sharing', 'Storage use per site'],
  },
  configuration: {
    summary: 'Intune configuration profiles and their assignment status.',
    capabilities: ['Profiles by platform and assignment', 'Devices where a profile failed or conflicts'],
  },
  'risky-users': {
    summary: 'Users flagged by Microsoft Entra ID Protection.',
    capabilities: [
      'Risk level, state, and the detections behind it',
      'Confirm compromised or dismiss risk (armed)',
    ],
  },
  incidents: {
    summary: 'Microsoft Defender incidents and alerts.',
    capabilities: ['Open incidents by severity', 'Jump from an incident to the affected users and devices'],
  },
  'secure-score': {
    summary: 'Microsoft Secure Score and recommended actions.',
    capabilities: ['Score trend over time', 'Actions ranked by impact'],
  },
  subscriptions: {
    summary: 'Azure subscriptions you can see.',
    capabilities: ['State, offer, and your role on each', 'Quick links into resources and costs'],
  },
  resources: {
    summary: 'Azure resources from Resource Graph.',
    capabilities: [
      'Filter by type, region, tag, and resource group',
      'Find untagged resources',
      'Open any resource in the inspector',
    ],
  },
  'function-apps': {
    summary: 'Azure Function Apps and their functions.',
    capabilities: [
      'Failures, latency, and top errors',
      'Functions without Entra authentication',
      'Restart, stop, start, or sync triggers (armed)',
    ],
  },
  arc: {
    summary: 'Azure Arc-enabled servers and Kubernetes clusters.',
    capabilities: ['Connectivity status and agent version', 'Installed extensions'],
  },
  monitoring: {
    summary: 'Azure Monitor alerts, metrics, and Log Analytics queries.',
    capabilities: ['Fired alerts by severity', 'Saved KQL queries with results as tables and charts'],
  },
  rbac: {
    summary: 'Azure role assignments.',
    capabilities: ['Who has which role on which scope', 'Privileged assignments at subscription scope'],
  },
  runs: {
    summary: 'Playbook and runbook runs.',
    capabilities: [
      'Live step timeline for each run',
      'Approvals waiting on you',
      'Re-run with the same inputs',
    ],
  },
  playbooks: {
    summary: 'Declarative playbooks: guided, audited changes.',
    capabilities: [
      'Preflight checks and a dry-run plan before anything changes',
      'Two-person approval for sensitive steps',
    ],
  },
  runbooks: {
    summary: 'Guided procedures with inline executable steps.',
    capabilities: [
      'Compromised account response, break-glass validation, leaver process',
      'Checklists with progress saved per run',
    ],
  },
  catalog: {
    summary: 'Every report you can run or schedule.',
    capabilities: [
      'Inactive users and guests, stale devices, credential expiry',
      'Export to CSV or Excel, or schedule delivery',
    ],
  },
  reports: {
    summary: 'Exportable reports.',
    capabilities: [
      'Inactive users and guests, stale devices, credential expiry',
      'Export to CSV or Excel, or schedule delivery',
    ],
  },
  schedules: {
    summary: 'Scheduled reports, probes, and jobs that run on this host.',
    capabilities: [
      'Next runs, history, and failures',
      'Enable, disable, or run now',
      'Cron with a plain-language preview',
    ],
  },
  probes: {
    summary: 'Synthetic monitoring of the services AdminForge depends on.',
    capabilities: [
      'Graph and ARM latency, token acquisition, certificate expiry',
      'Alerts when a probe fails',
    ],
  },
  dashboards: {
    summary: 'Dashboards built from content.',
    capabilities: ['Identity health, Azure inventory, security posture', 'Add widgets without a release'],
  },
  appearance: {
    summary: 'Runtime appearance: accent, radius scale, and default density.',
    capabilities: ['Live preview with automatic contrast checks', 'Publish and roll back, audited'],
  },
  settings: {
    summary: 'Portal settings.',
    capabilities: ['Role groups, write-session limits, and integrations'],
  },
};

/** Keys may be namespaced ("identity.users") and hrefs may be generic ("/p/identity.users"). */
export function plannedPage(key: string | undefined, href: string): PlannedPage | undefined {
  const last = href.split('/').filter(Boolean).pop();
  const candidates = [key, key?.split('.').pop(), last, last?.split('.').pop()];
  for (const c of candidates) if (c && PLANNED[c]) return PLANNED[c];
  return undefined;
}
