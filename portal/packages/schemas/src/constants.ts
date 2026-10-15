/** Zod-free constants, importable by the web shell without pulling validators into the initial bundle. */

/** Portal roles = app roles on the Read app, assigned to groups (§5.3). */
export const PORTAL_ROLES = [
  'Portal.Reader',
  'Portal.Operator',
  'Playbook.Author',
  'Playbook.Approver',
  'Portal.Admin',
] as const;
