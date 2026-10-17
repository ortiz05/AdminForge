/**
 * The `directory` test fixture's catalogue (pure data): the people, groups and administrative unit an enterprise
 * directory has and the live suite needs answers for — departments, job titles, employee ids, usage locations in four
 * countries (and one left unset), a manager chain whose top manager is disabled, a disabled user licensed directly, a
 * user with no attributes at all, one whose password never expires, a dynamic, a nested, two Microsoft 365 (one
 * without an owner), an empty and a group-licensing group, and an administrative unit holding every AF-Test user —
 * plus the `guest` fixture's guest, who never redeems their invitation. Plan: provision/directory-fixture-plan.ts;
 * Graph I/O: provision/directory-fixture-io.ts.
 *
 * Every object is AF-Test-*, carries provisioning's marker (users and the guest: `employeeType` DIRECTORY_MARKER;
 * groups and the administrative unit: the marker in the description) and is safe to delete. Values only make sense
 * in a test tenant: departments start with "AF-Test " so the dynamic group's rule can never match a real person.
 * Names include an apostrophe and non-Latin letters (search and filter escaping, `$odataSearch()`). Passwords are
 * random and never stored: nobody signs in as these accounts.
 */
import { TESTER_MARKER } from './identities-plan';

/** `employeeType` of the directory fixture's users and guest: provisioning's own. */
export const DIRECTORY_MARKER = 'AdminForge test fixture';
/** Group and administrative unit descriptions carry TESTER_MARKER (the same rule as the Intune fixtures). */
export const DIRECTORY_DESCRIPTION = `${TESTER_MARKER} fixture (directory), created by \`adminforge provision test-identities\`. Safe to delete.`;

export type DirectoryUserKey = '04' | '05' | '06' | '07' | '08' | '09' | '10' | '11' | '12';

export interface DirectoryUserSpec {
  key: DirectoryUserKey;
  upn: string;
  displayName: string;
  mailNickname: string;
  /** Profile attributes the fixture keeps as listed (absent = must stay unset). */
  attributes: Partial<
    Record<'givenName' | 'surname' | 'department' | 'jobTitle' | 'employeeId' | 'usageLocation', string>
  >;
  managerKey?: DirectoryUserKey;
  accountEnabled: boolean;
  passwordNeverExpires?: boolean;
  /** Licensed directly with AF_TEST_LICENCE_SKU (one seat). */
  directLicence?: boolean;
}

/** Profile attributes the fixture manages (all of them, so "no attributes" is checked too). */
export const PROFILE_ATTRIBUTES = [
  'givenName',
  'surname',
  'department',
  'jobTitle',
  'employeeId',
  'usageLocation',
] as const;

/** A member a fixture group or the administrative unit should have. */
export type MemberRef =
  | { user: DirectoryUserKey }
  /** AF-Test-User-01..03 (the base write-test targets), by UPN. */
  | { target: string }
  /** AF-Test-Group-01 itself (nesting). */
  | { testGroup: true };

export type DirectoryGroupKey = 'dynamic' | 'nested' | 'm365' | 'm365NoOwner' | 'empty' | 'licence';

export interface DirectoryGroupSpec {
  key: DirectoryGroupKey;
  /** Mail nickname (groups are found by display name; the description's marker makes them provisioning's). */
  uniqueName: string;
  displayName: string;
  /** How the plan names it. */
  kind: string;
  /** The create body (description carries the marker). */
  body: Record<string, unknown>;
  /** Assigned members (dynamic groups have none: the rule decides). */
  members: MemberRef[];
  owners: DirectoryUserKey[];
  /** Exactly these members: anything else is removed (the empty group). Otherwise extra members are left. */
  exactMembers?: boolean;
  /** Group-based licensing: AF_TEST_LICENCE_SKU with this service plan turned off. */
  licence?: { disabledPlan: string };
}

export interface DirectoryCatalog {
  users: DirectoryUserSpec[];
  guest: { displayName: string; email: string };
  groups: DirectoryGroupSpec[];
  au: { displayName: string; description: string };
}

const user = (
  n: DirectoryUserKey,
  domain: string,
  rest: Omit<DirectoryUserSpec, 'key' | 'upn' | 'displayName' | 'mailNickname'>,
): DirectoryUserSpec => ({
  key: n,
  upn: `af-test-user-${n}@${domain}`,
  displayName: `AF-Test-User-${n}`,
  mailNickname: `af-test-user-${n}`,
  ...rest,
});

const securityGroup = (mailNickname: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  displayName,
  description: DIRECTORY_DESCRIPTION,
  mailEnabled: false,
  mailNickname,
  securityEnabled: true,
  groupTypes: [],
  ...extra,
});

const m365Group = (mailNickname: string, displayName: string) => ({
  displayName,
  description: DIRECTORY_DESCRIPTION,
  mailEnabled: true,
  mailNickname,
  securityEnabled: false,
  groupTypes: ['Unified'],
  visibility: 'Private',
});

/** The dynamic group's rule: a test-only department value, so it can never include a real person. */
export const DYNAMIC_RULE = '(user.department -eq "AF-Test Sales")';
/** Service plan turned off in the group-licensing group (harmless; present in Microsoft 365 E3/E5). */
export const GROUP_LICENCE_DISABLED_PLAN = 'SWAY';

/** Pure: the catalogue for a tenant domain. Order matters: managers come before the people who report to them. */
export function directoryCatalog(domain: string): DirectoryCatalog {
  return {
    users: [
      user('07', domain, {
        // The disabled manager: someone left, their reports still point at them.
        attributes: {
          givenName: 'Lukas',
          surname: 'Müller',
          department: 'AF-Test Leadership',
          jobTitle: 'Vice President (left)',
          employeeId: 'AFT-1007',
          usageLocation: 'DE',
        },
        accountEnabled: false,
      }),
      user('06', domain, {
        attributes: {
          givenName: '伟',
          surname: '王',
          department: 'AF-Test Sales',
          jobTitle: 'Sales Director',
          employeeId: 'AFT-1006',
          usageLocation: 'US',
        },
        managerKey: '07',
        accountEnabled: true,
      }),
      user('04', domain, {
        attributes: {
          givenName: 'Siobhán',
          surname: "O'Brien",
          department: 'AF-Test Sales',
          jobTitle: 'Account Manager',
          employeeId: 'AFT-1004',
          usageLocation: 'GB',
        },
        managerKey: '06',
        accountEnabled: true,
      }),
      user('05', domain, {
        attributes: {
          givenName: 'Ελένη',
          surname: 'Παπαδοπούλου',
          department: 'AF-Test Sales',
          jobTitle: 'Sales Associate',
          employeeId: 'AFT-1005',
          usageLocation: 'US',
        },
        managerKey: '04',
        accountEnabled: true,
      }),
      user('08', domain, {
        // Disabled but still licensed directly (the "disabled users with licences" finding).
        attributes: {
          givenName: 'Anna',
          surname: 'Schmidt',
          department: 'AF-Test Finance',
          jobTitle: 'Accountant',
          employeeId: 'AFT-1008',
          usageLocation: 'DE',
        },
        managerKey: '07',
        accountEnabled: false,
        directLicence: true,
      }),
      // No attributes at all (completeness reports, "—" in lists).
      user('09', domain, { attributes: {}, accountEnabled: true }),
      user('10', domain, {
        attributes: {
          givenName: 'José',
          surname: 'Núñez',
          department: 'AF-Test Engineering',
          jobTitle: 'Engineer',
          employeeId: 'AFT-1010',
          usageLocation: 'AU',
        },
        managerKey: '06',
        accountEnabled: true,
        passwordNeverExpires: true,
      }),
      user('11', domain, {
        // Licensed through AF-Test-Licence-01: group-based licensing gives a user without a usage location the
        // tenant's, so the "no usage location" case is AF-Test-User-09.
        attributes: {
          givenName: 'Priya',
          surname: 'Patel',
          department: 'AF-Test Engineering',
          jobTitle: 'Engineer',
          employeeId: 'AFT-1011',
          usageLocation: 'US',
        },
        accountEnabled: true,
      }),
      user('12', domain, {
        attributes: {
          givenName: 'Chloé',
          surname: 'Martin',
          department: 'AF-Test Finance',
          jobTitle: 'Finance Analyst',
          employeeId: 'AFT-1012',
          usageLocation: 'AU',
        },
        accountEnabled: true,
      }),
    ],
    // example.com (RFC 2606): nobody can receive or redeem the invitation, and none is sent.
    guest: { displayName: 'AF-Test-Guest-01', email: 'af-test-guest-01@example.com' },
    groups: [
      {
        key: 'dynamic',
        kind: 'dynamic security group, rule on the test department',
        uniqueName: 'af-test-dynamic-01',
        displayName: 'AF-Test-Dynamic-01',
        body: securityGroup('af-test-dynamic-01', 'AF-Test-Dynamic-01', {
          groupTypes: ['DynamicMembership'],
          membershipRule: DYNAMIC_RULE,
          membershipRuleProcessingState: 'On',
        }),
        members: [],
        owners: [],
      },
      {
        key: 'nested',
        kind: 'security group containing AF-Test-Group-01',
        uniqueName: 'af-test-nested-01',
        displayName: 'AF-Test-Nested-01',
        body: securityGroup('af-test-nested-01', 'AF-Test-Nested-01'),
        members: [{ testGroup: true }, { user: '05' }],
        owners: [],
      },
      {
        key: 'm365',
        kind: 'Microsoft 365 group with an owner',
        uniqueName: 'af-test-m365-01',
        displayName: 'AF-Test-M365-01',
        body: m365Group('af-test-m365-01', 'AF-Test-M365-01'),
        members: [{ user: '04' }, { user: '05' }],
        owners: ['04'],
      },
      {
        key: 'm365NoOwner',
        kind: 'Microsoft 365 group without an owner',
        uniqueName: 'af-test-m365-02',
        displayName: 'AF-Test-M365-02',
        body: m365Group('af-test-m365-02', 'AF-Test-M365-02'),
        members: [{ user: '06' }],
        owners: [],
      },
      {
        key: 'empty',
        kind: 'security group without members',
        uniqueName: 'af-test-empty-01',
        displayName: 'AF-Test-Empty-01',
        body: securityGroup('af-test-empty-01', 'AF-Test-Empty-01'),
        members: [],
        owners: [],
        exactMembers: true,
      },
      {
        key: 'licence',
        kind: 'group-based licensing',
        uniqueName: 'af-test-licence-01',
        displayName: 'AF-Test-Licence-01',
        body: securityGroup('af-test-licence-01', 'AF-Test-Licence-01'),
        members: [{ user: '11' }, { user: '12' }],
        owners: [],
        licence: { disabledPlan: GROUP_LICENCE_DISABLED_PLAN },
      },
    ],
    au: { displayName: 'AF-Test-AU-01', description: DIRECTORY_DESCRIPTION },
  };
}

/** Seats the directory fixture takes from AF_TEST_LICENCE_SKU: the direct licence plus the licence group's members. */
export const directorySeats = (c: DirectoryCatalog) =>
  c.users.filter((u) => u.directLicence).length +
  c.groups.filter((g) => g.licence).reduce((n, g) => n + g.members.length, 0);
