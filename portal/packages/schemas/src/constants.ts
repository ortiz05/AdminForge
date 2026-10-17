/** Zod-free constants, importable by the web shell without pulling validators into the initial bundle. */

/** Where a `kql` check or a Query Studio query runs (R12). Here, not in probe.ts, so api.ts can use it without a cycle. */
export const KQL_SOURCES = ['resourceGraph', 'logAnalytics', 'advancedHunting'] as const;

/** Portal roles = app roles on the Read app, assigned to groups (§5.3). */
export const PORTAL_ROLES = [
  'Portal.Reader',
  'Portal.Operator',
  'Playbook.Author',
  'Playbook.Approver',
  'Portal.Admin',
] as const;
