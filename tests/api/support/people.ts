/**
 * The synthetic people and role sets API tests sign in as — one list, so every harness (runs, schedules, portal
 * schedules) agrees on who is who. Each person has a unique object id AND a unique UPN: tests that compare actors
 * (approver ≠ requester, creator vs. manager, the audit actor of a download) depend on two people never sharing either.
 * Synthetic only (`example.com`, generated GUIDs); never a real tenant.
 *
 * Used with `sessionFor` / `t.login(person, roles)` (tests/api/support/app.ts); re-exported by runs-helpers.ts,
 * schedules-helpers.ts and portal-schedules-helpers.ts, which most tests import them from.
 */

/** A signed-in person as the API sees them: Entra object id and sign-in name. */
export interface TestPerson {
  readonly oid: string;
  readonly upn: string;
}

/** Operator and author in most tests; the requester in approval tests. */
export const AVERY: TestPerson = { oid: '00000000-0000-4000-8000-0000000000a1', upn: 'avery@example.com' };
/** A second operator: the approver, or "someone else" in ownership tests. */
export const BLAKE: TestPerson = { oid: '00000000-0000-4000-8000-0000000000b2', upn: 'blake@example.com' };
/** A third person (runs: beneficiary / bystander). */
export const CASEY: TestPerson = { oid: '00000000-0000-4000-8000-0000000000c3', upn: 'casey@example.com' };
/** A fourth person (runs: manual actor). */
export const DREW: TestPerson = { oid: '00000000-0000-4000-8000-0000000000d4', upn: 'drew@example.com' };
/** A Portal.Admin who manages other people's portal schedules. */
export const DANA: TestPerson = { oid: '00000000-0000-4000-8000-0000000000e5', upn: 'dana@example.com' };
/** A reader (usually signed in with Portal.Reader only) in schedules, probes, news and report tests. */
export const READER: TestPerson = { oid: '00000000-0000-4000-8000-0000000000f6', upn: 'reader@example.com' };

/** Every portal role. */
export const ALL_ROLES = [
  'Portal.Reader',
  'Portal.Operator',
  'Playbook.Author',
  'Playbook.Approver',
  'Portal.Admin',
];
/** Reader + Operator (may run write playbooks and manage their own report schedules). */
export const OPERATOR = ['Portal.Reader', 'Portal.Operator'];
/** Reader + Operator + Admin. */
export const ADMIN = ['Portal.Reader', 'Portal.Operator', 'Portal.Admin'];
