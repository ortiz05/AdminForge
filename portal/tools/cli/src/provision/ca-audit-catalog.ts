/**
 * The `ca-audit` test fixture's catalogue: example Conditional Access policies modelled on Microsoft's recommended
 * baseline and policy templates, all **report-only** (`enabledForReportingButNotEnforced`). Report-only policies are
 * evaluated at every sign-in and their result is logged (the sign-in's "Report-only" tab, Conditional Access insights)
 * but never enforced, so they give the CA pages real examples and data without changing anyone's sign-in.
 *
 * Report-only is the only state this module can produce: a create's body type allows no other state and
 * `assertReportOnly` runs before every create; an update (`auditPolicyPatch`) carries no state at all, so it can't
 * change one (provision/ca-audit-io.ts). Nothing here ever turns a policy on.
 *
 * Scope: most policies target all users (or the admin roles, or guests) so real sign-ins produce results, excluding
 * the accounts in AF_PROTECTED_USER_IDS (break-glass / emergency access) and, like Microsoft's templates, the
 * Directory Synchronization Accounts role. A policy that **blocks** all users also excludes the Global Administrator
 * role: Graph refuses a block that could lock everyone out (400 "1032 … BlockEveryonePolicy" when nobody is
 * excluded). Policies whose grant depends on the device
 * (compliant or hybrid-joined device, app protection) target AF-Test-Group-01 only: Microsoft documents that report-only
 * device-state policies can prompt macOS, iOS and Android users to choose a device certificate. The location example
 * targets AF-Test-Group-01 too (outside a documentation range, it would "block" every sign-in in the report).
 *
 * Pure data and builders; the plan is provision/ca-audit-plan.ts, the Graph I/O provision/ca-audit-io.ts.
 */
import { ConfigError } from '../shared/errors';
import { isGuid } from './ids';

/** The only state the fixture's policies ever have. */
export const REPORT_ONLY = 'enabledForReportingButNotEnforced' as const;
export type ReportOnly = typeof REPORT_ONLY;

/** Every catalogue policy's name starts with this. */
export const CA_AUDIT_PREFIX = 'AF-Audit: ';

/**
 * Microsoft's built-in "Phishing-resistant MFA" authentication strength (a well-known id, the same in every tenant).
 */
export const PHISHING_RESISTANT_MFA = '00000000-0000-0000-0000-000000000004';

/** Windows Azure Service Management API: the Azure portal, CLI, PowerShell and ARM (a well-known app id). */
export const AZURE_MANAGEMENT_APP = '797f4846-ba00-4fd7-ba43-dac1f8f63013';

/**
 * The privileged directory roles of Microsoft's "Require multifactor authentication for admins" template (role
 * template ids, the same in every tenant).
 */
export const ADMIN_ROLES: Readonly<Record<string, string>> = {
  'Global Administrator': '62e90394-69f5-4237-9190-012177145e10',
  'Application Administrator': '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3',
  'Authentication Administrator': 'c4e39bd9-1100-46d3-8c65-fb160da0071f',
  'Billing Administrator': 'b0f54661-2d74-4c50-afa3-1ec803f12efe',
  'Cloud Application Administrator': '158c047a-c907-4556-b7ef-446551a6b5f7',
  'Conditional Access Administrator': 'b1be1c3e-b65d-4f19-8427-f6fa0d97feb9',
  'Exchange Administrator': '29232cdf-9323-42fd-ade2-1d097af3e4de',
  'Helpdesk Administrator': '729827e3-9c14-49f7-bb1b-9608f156bbb8',
  'Password Administrator': '966707d0-3269-4727-9be2-8c3a10f19b9d',
  'Privileged Authentication Administrator': '7be44c8a-adaf-4e2a-84d6-ab2649e08a13',
  'Privileged Role Administrator': 'e8611ab8-c189-46e8-94e1-60213ab1f814',
  'Security Administrator': '194ae4cb-b126-40b2-bd5b-6091b380977d',
  'SharePoint Administrator': 'f28a1f50-f6e7-4571-818b-6a12f2af6b6c',
  'User Administrator': 'fe930be7-5e62-47db-91af-98c3a49a38b1',
};

/** Directory Synchronization Accounts (Entra Connect's sync account): excluded from all-users policies, as in
 * Microsoft's templates. */
export const DIRECTORY_SYNC_ROLE = 'd29b2b05-8046-44ba-8758-1e26182fcf32';

/** Every kind of guest and external user (Graph's `guestOrExternalUserTypes`). */
const GUEST_TYPES =
  'internalGuest,b2bCollaborationGuest,b2bCollaborationMember,b2bDirectConnectUser,otherExternalUser,serviceProvider';

type Json = Record<string, unknown>;

/** Who a catalogue policy targets. `testGroup` = AF-Test-Group-01 only (device-dependent and location examples). */
export type AuditScope = 'allUsers' | 'adminRoles' | 'guests' | 'testGroup';

export interface AuditPolicySpec {
  displayName: string;
  /** What the policy's report-only results show (docs and the plan). */
  shows: string;
  scope: AuditScope;
  /** `conditions.applications` (default: all cloud apps). */
  applications?: Json;
  /** `conditions.clientAppTypes` (default: all). */
  clientAppTypes?: string[];
  platforms?: Json;
  /** Exclude AF-Test-Location (the `named-location` fixture) from "all locations". */
  outsideTestLocation?: boolean;
  signInRiskLevels?: string[];
  userRiskLevels?: string[];
  grantControls: Json | null;
  sessionControls?: Json | null;
}

const ALL_APPS = { includeApplications: ['All'] };
const MFA = { operator: 'OR', builtInControls: ['mfa'] };
const BLOCK = { operator: 'OR', builtInControls: ['block'] };
/** Risk-based policies: Microsoft's templates require a fresh sign-in each time (sign-in frequency "every time"). */
const EVERY_TIME = {
  signInFrequency: {
    isEnabled: true,
    frequencyInterval: 'everyTime',
    authenticationType: 'primaryAndSecondaryAuthentication',
  },
};

/** The catalogue, in the order the plan lists it. */
export const CA_AUDIT_POLICIES: readonly AuditPolicySpec[] = [
  {
    // Which administrator sign-ins already satisfy MFA, and which wouldn't.
    displayName: `${CA_AUDIT_PREFIX}Require MFA for administrators`,
    shows: 'which administrator sign-ins already satisfy MFA',
    scope: 'adminRoles',
    grantControls: MFA,
  },
  {
    // How far admins are from phishing-resistant sign-in (FIDO2, Windows Hello, certificate).
    displayName: `${CA_AUDIT_PREFIX}Require phishing-resistant MFA for administrators`,
    shows: 'administrator sign-ins that would fail phishing-resistant MFA',
    scope: 'adminRoles',
    grantControls: { operator: 'OR', authenticationStrength: { id: PHISHING_RESISTANT_MFA } },
  },
  {
    // The baseline: every user, every app.
    displayName: `${CA_AUDIT_PREFIX}Require MFA for all users`,
    shows: 'sign-ins that would need MFA they did not perform',
    scope: 'allUsers',
    grantControls: MFA,
  },
  {
    // Who still uses legacy protocols (IMAP, POP, SMTP AUTH, ActiveSync basic auth) that can't do MFA.
    displayName: `${CA_AUDIT_PREFIX}Block legacy authentication`,
    shows: 'legacy-protocol sign-ins that would be blocked',
    scope: 'allUsers',
    clientAppTypes: ['exchangeActiveSync', 'other'],
    grantControls: BLOCK,
  },
  {
    // Azure portal, CLI, PowerShell and ARM sign-ins without MFA.
    displayName: `${CA_AUDIT_PREFIX}Require MFA for Azure management`,
    shows: 'Azure management sign-ins without MFA',
    scope: 'allUsers',
    applications: { includeApplications: [AZURE_MANAGEMENT_APP] },
    grantControls: MFA,
  },
  {
    // Guests and external users signing in to the tenant's resources.
    displayName: `${CA_AUDIT_PREFIX}Require MFA for guests and external users`,
    shows: 'guest and external sign-ins without MFA',
    scope: 'guests',
    grantControls: MFA,
  },
  {
    // Registering or joining a device to Entra ID.
    displayName: `${CA_AUDIT_PREFIX}Require MFA to register or join devices`,
    shows: 'device registrations without MFA',
    scope: 'allUsers',
    applications: { includeUserActions: ['urn:user:registerdevice'] },
    grantControls: MFA,
  },
  {
    // Sign-ins Identity Protection rates medium or high risk (Entra ID P2).
    displayName: `${CA_AUDIT_PREFIX}Require MFA for medium or high sign-in risk`,
    shows: 'risky sign-ins that would be challenged',
    scope: 'allUsers',
    signInRiskLevels: ['high', 'medium'],
    grantControls: MFA,
    sessionControls: EVERY_TIME,
  },
  {
    // Users Identity Protection rates high risk (likely compromised; Entra ID P2).
    displayName: `${CA_AUDIT_PREFIX}Require password change for high user risk`,
    shows: 'high-risk users who would have to change their password',
    scope: 'allUsers',
    userRiskLevels: ['high'],
    grantControls: { operator: 'AND', builtInControls: ['mfa', 'passwordChange'] },
    sessionControls: EVERY_TIME,
  },
  {
    // Sign-ins from platforms nobody should use (Windows Phone, unknown user agents).
    displayName: `${CA_AUDIT_PREFIX}Block unknown device platforms`,
    shows: 'sign-ins from unknown or unsupported platforms',
    scope: 'allUsers',
    platforms: {
      includePlatforms: ['all'],
      excludePlatforms: ['android', 'iOS', 'windows', 'macOS', 'linux'],
    },
    grantControls: BLOCK,
  },
  {
    // Admin sessions: re-authenticate every 4 hours, never stay signed in.
    displayName: `${CA_AUDIT_PREFIX}Admin sign-in frequency and no persistent browser`,
    shows: 'admin sessions longer than 4 hours or kept in a persistent browser',
    scope: 'adminRoles',
    grantControls: null,
    sessionControls: {
      signInFrequency: {
        isEnabled: true,
        type: 'hours',
        value: 4,
        frequencyInterval: 'timeBased',
        authenticationType: 'primaryAndSecondaryAuthentication',
      },
      persistentBrowser: { isEnabled: true, mode: 'never' },
    },
  },
  {
    // Device-based access (AF-Test-Group-01 only: report-only device policies can prompt for a device certificate).
    displayName: `${CA_AUDIT_PREFIX}Require compliant or hybrid-joined device`,
    shows: 'sign-ins from devices that are neither compliant nor hybrid-joined',
    scope: 'testGroup',
    grantControls: { operator: 'OR', builtInControls: ['compliantDevice', 'domainJoinedDevice'] },
  },
  {
    // Mobile app protection (Intune app protection policies; AF-Test-Group-01 only, as above).
    displayName: `${CA_AUDIT_PREFIX}Require app protection on mobile`,
    shows: 'mobile sign-ins from apps without an app protection policy',
    scope: 'testGroup',
    platforms: { includePlatforms: ['android', 'iOS'] },
    grantControls: { operator: 'OR', builtInControls: ['compliantApplication'] },
  },
  {
    // A named-location example (AF-Test-Group-01 only: everyone is "outside" a documentation range).
    displayName: `${CA_AUDIT_PREFIX}Block access outside AF-Test-Location`,
    shows: 'how a location-based block reads in the report',
    scope: 'testGroup',
    outsideTestLocation: true,
    grantControls: BLOCK,
  },
];

/** Whether a policy name is one of the catalogue's. */
export const isCatalogueName = (name: string) => CA_AUDIT_POLICIES.some((p) => p.displayName === name);

/** The ids a policy body refers to (resolved from the tenant). */
export interface AuditIds {
  /** AF-Test-Group-01. */
  testGroupId?: string;
  /** AF_PROTECTED_USER_IDS: excluded from every policy that isn't scoped to AF-Test-Group-01. */
  protectedUserIds: readonly string[];
  /** AF-Test-Location (the named-location fixture). */
  testLocationId?: string;
}

/** A catalogue policy as sent to Graph: the state can only be report-only. */
export interface AuditPolicyBody {
  displayName: string;
  state: ReportOnly;
  conditions: Json;
  grantControls: Json | null;
  sessionControls: Json | null;
}

/** Whether a policy's grant blocks access. */
export const blocks = (spec: Pick<AuditPolicySpec, 'grantControls'>) =>
  ((spec.grantControls?.builtInControls as string[] | undefined) ?? []).includes('block');

function users(spec: AuditPolicySpec, ids: AuditIds): Json {
  const exclude = ids.protectedUserIds.length ? { excludeUsers: [...ids.protectedUserIds] } : {};
  switch (spec.scope) {
    case 'allUsers':
      return {
        includeUsers: ['All'],
        ...exclude,
        // The sync account (Microsoft's templates), and for a block also Global Administrator: Graph refuses a policy
        // that blocks everyone (BlockEveryonePolicy).
        excludeRoles: [...(blocks(spec) ? [ADMIN_ROLES['Global Administrator']!] : []), DIRECTORY_SYNC_ROLE],
      };
    case 'adminRoles':
      return { includeRoles: Object.values(ADMIN_ROLES), ...exclude };
    case 'guests':
      return {
        includeGuestsOrExternalUsers: {
          guestOrExternalUserTypes: GUEST_TYPES,
          externalTenants: {
            '@odata.type': '#microsoft.graph.conditionalAccessAllExternalTenants',
            membershipKind: 'all',
          },
        },
        ...exclude,
      };
    case 'testGroup':
      // The testers only: no exclusions needed (and their sign-ins should produce report-only results).
      return { includeGroups: ids.testGroupId ? [ids.testGroupId] : [] };
  }
}

/** Pure: the body of a catalogue policy for this tenant. */
export function buildAuditPolicy(spec: AuditPolicySpec, ids: AuditIds): AuditPolicyBody {
  const conditions: Json = {
    users: users(spec, ids),
    applications: spec.applications ?? ALL_APPS,
    clientAppTypes: spec.clientAppTypes ?? ['all'],
    ...(spec.platforms ? { platforms: spec.platforms } : {}),
    ...(spec.outsideTestLocation
      ? {
          locations: {
            includeLocations: ['All'],
            excludeLocations: ids.testLocationId ? [ids.testLocationId] : [],
          },
        }
      : {}),
    ...(spec.signInRiskLevels ? { signInRiskLevels: spec.signInRiskLevels } : {}),
    ...(spec.userRiskLevels ? { userRiskLevels: spec.userRiskLevels } : {}),
  };
  return {
    displayName: spec.displayName,
    state: REPORT_ONLY,
    conditions,
    grantControls: spec.grantControls,
    sessionControls: spec.sessionControls ?? null,
  };
}

/**
 * The last check before a create reaches Graph: a catalogue body must be report-only. The type already says so; this
 * holds even if a body is assembled some other way. Throws (a programming error, never a Graph error).
 */
export function assertReportOnly(body: { state?: unknown; displayName?: unknown }): void {
  if (body.state !== REPORT_ONLY)
    throw new Error(
      `Refusing to send Conditional Access policy "${String(body.displayName)}" in state "${String(body.state)}": the ca-audit fixture only creates report-only policies.`,
    );
}

/** An update: everything but the state (an update never changes it — only report-only policies are updated). */
export type AuditPolicyPatch = Omit<AuditPolicyBody, 'state'>;

/** Every scope list or condition a policy can carry, empty: what an update sends for the parts the catalogue omits. */
const EMPTY_USERS = {
  includeUsers: [],
  excludeUsers: [],
  includeGroups: [],
  excludeGroups: [],
  includeRoles: [],
  excludeRoles: [],
  includeGuestsOrExternalUsers: null,
  excludeGuestsOrExternalUsers: null,
};
const EMPTY_APPLICATIONS = {
  includeApplications: [],
  excludeApplications: [],
  includeUserActions: [],
  includeAuthenticationContextClassReferences: [],
  applicationFilter: null,
};
const EMPTY_CONDITIONS = {
  platforms: null,
  locations: null,
  signInRiskLevels: [],
  userRiskLevels: [],
  servicePrincipalRiskLevels: [],
  clientApplications: null,
  devices: null,
};
const EMPTY_GRANT = {
  builtInControls: [],
  customAuthenticationFactors: [],
  termsOfUse: [],
  authenticationStrength: null,
};
const EMPTY_SESSION = {
  applicationEnforcedRestrictions: null,
  cloudAppSecurity: null,
  persistentBrowser: null,
  signInFrequency: null,
};

/**
 * Pure: the update for a catalogue body. Graph merges a PATCH into nested objects, so every list and condition the
 * catalogue doesn't set is sent explicitly empty (or null) — otherwise a scope someone widened (e.g. "All" added to a
 * test-group policy) would survive the update. No `state`: an update never changes it.
 */
export function auditPolicyPatch(body: AuditPolicyBody): AuditPolicyPatch {
  const c = body.conditions;
  return {
    displayName: body.displayName,
    conditions: {
      ...EMPTY_CONDITIONS,
      ...c,
      users: { ...EMPTY_USERS, ...(c.users as Json) },
      applications: { ...EMPTY_APPLICATIONS, ...(c.applications as Json) },
    },
    grantControls: body.grantControls ? { ...EMPTY_GRANT, ...body.grantControls } : null,
    sessionControls: body.sessionControls ? { ...EMPTY_SESSION, ...body.sessionControls } : null,
  };
}

/** The last check before an update reaches Graph: it must not carry a state (it can't change one). */
export function assertNoState(patch: object): void {
  if ('state' in patch)
    throw new Error(
      'Refusing to send a Conditional Access update with a state: the ca-audit fixture never changes one.',
    );
}

/** AF_PROTECTED_USER_IDS → object ids (excluded from the audit policies). Throws, naming the key, on a non-id. */
export function protectedUserIds(env: Readonly<Record<string, string | undefined>>): string[] {
  const ids = (env.AF_PROTECTED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.some((id) => !isGuid(id)))
    throw new ConfigError('AF_PROTECTED_USER_IDS must be a comma-separated list of user object ids.');
  return ids;
}
