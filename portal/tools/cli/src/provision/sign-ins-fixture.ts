/**
 * The `sign-ins` test fixture: two accounts whose only job is to sign in, so sign-in pages, report-only Conditional
 * Access results and inactive-user reports have real data — AF-Test-SignIn-01 signs in successfully (MFA by a TOTP
 * seed, registered on its first sign-in like the validation user) and AF-Test-SignIn-02 fails: a wrong password, then
 * a sign-in while disabled. The sign-ins themselves are made by tests/live/scripts/generate-sign-ins.ts.
 *
 * The accounts hold nothing: no portal role, no directory role, no licence, no group. They are created disabled with
 * their own marker (`employeeType` SIGNIN_MARKER), excluded from the registration campaign (headless Chrome can't
 * complete its nudge), and enabled only by the sign-in script for its run; `provision test-identities --disable`
 * disables them too. Their UPNs and passwords go to the admin env file (AF_TEST_SIGNIN_<n>_UPN / _PASSWORD), never to
 * output. Plan (pure) and Graph I/O in one module.
 */
import { ApiError, type GraphClient } from '@adminforge/connectors';
import { isUnreadable, type DesiredFixtures, type FixtureOp, type Unreadable } from './fixtures-model';
import { readEligibleRoles } from './eligibility';
import { odata } from './entra-io';
import {
  excludeFromRegistrationCampaign,
  findUser,
  readRegistrationCampaign,
  readTesterRoleGrants,
  removeFromRegistrationCampaignExclusions,
  setUserEnabled,
} from './identities-io';
import { testerUpnProblem, type GraphUser, type RegistrationCampaign } from './identities-plan';
import { generatePassword } from './password';

export const SIGN_INS_SECTION = 'Test fixtures: sign-in accounts';
/** `employeeType` of the sign-in accounts: provisioning's own, distinct from the validation user and the approver. */
export const SIGNIN_MARKER = 'AdminForge validation sign-ins';

export interface SignInAccountSpec {
  n: 1 | 2;
  upn: string;
  displayName: string;
  mailNickname: string;
  /** What the sign-in script does with it. */
  role: string;
  upnKey: 'AF_TEST_SIGNIN_1_UPN' | 'AF_TEST_SIGNIN_2_UPN';
  passwordKey: 'AF_TEST_SIGNIN_1_PASSWORD' | 'AF_TEST_SIGNIN_2_PASSWORD';
  /** The TOTP seed key (the account that completes MFA). */
  totpKey?: 'AF_TEST_SIGNIN_1_TOTP_SECRET';
}

/** Pure: the two accounts for a domain. */
export const signInAccounts = (domain: string): SignInAccountSpec[] => [
  {
    n: 1,
    upn: `af-test-signin-01@${domain}`,
    displayName: 'AF-Test-SignIn-01',
    mailNickname: 'af-test-signin-01',
    role: 'signs in successfully (MFA)',
    upnKey: 'AF_TEST_SIGNIN_1_UPN',
    passwordKey: 'AF_TEST_SIGNIN_1_PASSWORD',
    totpKey: 'AF_TEST_SIGNIN_1_TOTP_SECRET',
  },
  {
    n: 2,
    upn: `af-test-signin-02@${domain}`,
    displayName: 'AF-Test-SignIn-02',
    mailNickname: 'af-test-signin-02',
    role: 'fails: wrong password, then signed in while disabled',
    upnKey: 'AF_TEST_SIGNIN_2_UPN',
    passwordKey: 'AF_TEST_SIGNIN_2_PASSWORD',
  },
];

/** Whether an account is a sign-in account provisioning created: an `af-` UPN and the marker. */
export const isSignInAccount = (u: Pick<GraphUser, 'userPrincipalName' | 'employeeType'>) =>
  !testerUpnProblem(u.userPrincipalName) && u.employeeType === SIGNIN_MARKER;

/**
 * What a sign-in account holds beyond nothing — it should hold none of it: group (or unit, or role) memberships,
 * directory roles (direct, scoped or through a group), PIM eligibility, licences, app role assignments.
 */
export type SignInPrivilege =
  | {
      memberships: number;
      directoryRoles: string[];
      eligibleRoles: string[];
      licences: number;
      appRoleAssignments: number;
    }
  | { unreadable: string };

/** Pure: lines naming what an account holds (empty = nothing, as it should be). */
export function privilegeLines(p: Exclude<SignInPrivilege, { unreadable: string }>): string[] {
  return [
    ...(p.memberships ? [`${p.memberships} group / unit / role membership(s)`] : []),
    ...p.directoryRoles.map((r) => `directory role ${r}`),
    ...p.eligibleRoles.map((r) => `PIM-eligible for ${r}`),
    ...(p.licences ? [`${p.licences} licence(s)`] : []),
    ...(p.appRoleAssignments ? [`${p.appRoleAssignments} app role assignment(s)`] : []),
  ];
}

export interface SignInsState {
  accounts: Partial<Record<1 | 2, GraphUser>>;
  /** Read for the accounts that carry the marker. */
  privilege: Partial<Record<1 | 2, SignInPrivilege>>;
  /** From the admin env file: which UPN and whether a password is stored (never the password itself). */
  env: Partial<Record<1 | 2, { upn?: string; hasPassword: boolean }>>;
  campaign?: RegistrationCampaign | { unreadable: string };
}

export type SignInsStep =
  | { op: 'account'; n: 1 | 2; mode: 'create' | 'resetPassword' }
  | { op: 'campaignExclusion'; n: 1 | 2 }
  | { op: 'delete'; n: 1 | 2; id: string };

const base = { fixture: 'sign-ins', section: SIGN_INS_SECTION } as const;
const blocked = (title: string, why: string): FixtureOp => ({
  ...base,
  kind: 'note',
  action: 'skip',
  blocked: true,
  title,
  changes: [why],
});
const step = (
  action: FixtureOp['action'],
  title: string,
  s: SignInsStep,
  changes: string[] = [],
): FixtureOp => ({
  ...base,
  kind: 'signIns',
  action,
  title,
  step: s,
  ...(changes.length ? { changes } : {}),
});

/** Pure: the sign-ins fixture's operations. */
export function planSignIns(
  d: DesiredFixtures,
  s: SignInsState | Unreadable | undefined,
  remove: boolean,
): FixtureOp[] {
  if (isUnreadable(s)) return [blocked('Sign-in accounts', s.unreadable)];
  if (!s) return [];
  const ops: FixtureOp[] = [];
  for (const spec of d.signIns) {
    const title = `${spec.displayName} (${spec.role})`;
    const u = s.accounts[spec.n];
    if (remove) {
      if (u && isSignInAccount(u)) ops.push(step('delete', title, { op: 'delete', n: spec.n, id: u.id }));
      continue;
    }
    if (u && !isSignInAccount(u)) {
      ops.push(
        blocked(
          title,
          `the account at this UPN has no "${SIGNIN_MARKER}" marker — not created by provisioning, left alone`,
        ),
      );
      continue;
    }
    const env = s.env[spec.n];
    const stored = env?.hasPassword && env.upn?.toLowerCase() === spec.upn.toLowerCase();
    if (!u)
      ops.push(
        step('create', title, { op: 'account', n: spec.n, mode: 'create' }, [
          'created disabled; no role, licence or group',
          `UPN and password to ${spec.upnKey} / ${spec.passwordKey} (admin env, not shown)`,
        ]),
      );
    else if (!stored)
      ops.push(
        step('update', title, { op: 'account', n: spec.n, mode: 'resetPassword' }, [
          `${spec.passwordKey} not in the admin env file — a new password is set and stored`,
        ]),
      );
    else if (s.privilege[spec.n] && 'unreadable' in s.privilege[spec.n]!)
      ops.push(
        blocked(
          title,
          `what it holds couldn't be checked: ${(s.privilege[spec.n] as { unreadable: string }).unreadable}`,
        ),
      );
    else if (
      s.privilege[spec.n] &&
      privilegeLines(s.privilege[spec.n] as Exclude<SignInPrivilege, { unreadable: string }>).length
    )
      ops.push(
        blocked(
          title,
          `holds ${privilegeLines(s.privilege[spec.n] as Exclude<SignInPrivilege, { unreadable: string }>).join(', ')} — not granted by provisioning (it should hold nothing); remove it in Entra ID`,
        ),
      );
    else
      ops.push({
        ...base,
        kind: 'note',
        action: 'noop',
        title,
        detail: `account ${u.accountEnabled === false ? 'disabled' : 'enabled'}`,
      });
    const campaign = s.campaign;
    const excludeTitle = `${spec.displayName} excluded from the registration campaign (sign-in nudge)`;
    if (!campaign) continue;
    if ('unreadable' in campaign)
      ops.push({
        ...base,
        kind: 'note',
        action: 'skip',
        title: excludeTitle,
        changes: [campaign.unreadable],
      });
    else {
      const excluded = !!u && campaign.excludeTargets.some((t) => t.id.toLowerCase() === u.id.toLowerCase());
      ops.push(
        excluded
          ? { ...base, kind: 'note', action: 'noop', title: excludeTitle }
          : step('create', excludeTitle, { op: 'campaignExclusion', n: spec.n }, [
              'only this account; the rest of the campaign is unchanged',
            ]),
      );
    }
  }
  return ops;
}

/** Reads the two accounts, what the admin env holds for them (presence only) and the campaign. Read-only. */
export async function readSignInsState(
  graph: GraphClient,
  d: DesiredFixtures,
  env: Readonly<Record<string, string | undefined>>,
): Promise<SignInsState> {
  const state: SignInsState = { accounts: {}, privilege: {}, env: {} };
  for (const spec of d.signIns) {
    const u = await findUser(graph, spec.upn);
    state.accounts[spec.n] = u;
    state.env[spec.n] = { upn: env[spec.upnKey] || undefined, hasPassword: !!env[spec.passwordKey] };
    // Someone else's account at the UPN is refused by the plan, never read further.
    if (u && isSignInAccount(u)) state.privilege[spec.n] = await readPrivilege(graph, u.id, spec.displayName);
  }
  state.campaign = await readRegistrationCampaign(graph);
  return state;
}

/** Everything an account holds (it should hold nothing). Read-only; a part that can't be read makes it unreadable. */
async function readPrivilege(graph: GraphClient, id: string, who: string): Promise<SignInPrivilege> {
  try {
    const memberOf = await graph.all<{ id: string }>({
      path: `/users/${id}/memberOf`,
      query: { $select: 'id' },
    });
    const direct = await graph.all<{ roleDefinitionId: string; directoryScopeId: string }>({
      path: '/roleManagement/directory/roleAssignments',
      query: { $filter: `principalId eq ${odata(id)}` },
    });
    const grants = await readTesterRoleGrants(graph, id, direct, `${who}'s`);
    if ('unreadable' in grants) return grants;
    const eligible = await readEligibleRoles(graph, id);
    // Without Entra ID P2 nobody can be eligible; any other unreadable answer means it couldn't be checked.
    if ('unreadable' in eligible && !/not available/.test(eligible.unreadable)) return eligible;
    const { data } = await graph.request<{ assignedLicenses?: unknown[] }>({
      path: `/users/${id}`,
      query: { $select: 'assignedLicenses' },
    });
    const appRoles = await graph.all<{ id: string }>({
      path: `/users/${id}/appRoleAssignments`,
      query: { $select: 'id' },
    });
    return {
      memberships: memberOf.length,
      directoryRoles: [...new Set(grants.map((g) => g.name ?? 'a role whose name could not be read'))],
      eligibleRoles:
        'unreadable' in eligible
          ? []
          : [...new Set(eligible.map((r) => r.name ?? 'a role whose name could not be read'))],
      licences: (data.assignedLicenses ?? []).length,
      appRoleAssignments: appRoles.length,
    };
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return {
      unreadable: `${who}'s memberships, roles or licences could not be read (${err.status} ${err.code})`,
    };
  }
}

/** Applies one sign-ins operation. Passwords go to `writeEnv` only, never to output. */
export async function applySignInsStep(
  s: SignInsStep,
  title: string,
  d: DesiredFixtures,
  ctx: {
    graph: GraphClient;
    log: (line: string) => void;
    writeEnv: (updates: Record<string, string>) => void;
    retry: <T>(fn: () => Promise<T>) => Promise<T>;
    password?: () => string;
  },
): Promise<void> {
  const { graph, log, retry } = ctx;
  const spec = d.signIns.find((a) => a.n === s.n)!;
  const own = () =>
    retry(async () => {
      const u = await findUser(graph, spec.upn);
      if (!u)
        return Promise.reject(
          new ApiError(404, 'Request_ResourceNotFound', `${spec.displayName} is not visible yet`),
        );
      if (!isSignInAccount(u))
        throw new ApiError(
          409,
          'NotProvisioned',
          `${spec.displayName} was not created by provisioning; left alone`,
        );
      return u;
    });
  switch (s.op) {
    case 'account': {
      const pwd = (ctx.password ?? (() => generatePassword()))();
      if (s.mode === 'create')
        await graph.request({
          method: 'POST',
          path: '/users',
          body: {
            accountEnabled: false,
            displayName: spec.displayName,
            mailNickname: spec.mailNickname,
            userPrincipalName: spec.upn,
            passwordProfile: { password: pwd, forceChangePasswordNextSignIn: false },
            passwordPolicies: 'DisablePasswordExpiration',
            employeeType: SIGNIN_MARKER,
          },
        });
      else {
        const u = await own();
        await retry(() =>
          graph.request({
            method: 'PATCH',
            path: `/users/${u.id}`,
            body: { passwordProfile: { password: pwd, forceChangePasswordNextSignIn: false } },
          }),
        );
      }
      ctx.writeEnv({ [spec.upnKey]: spec.upn, [spec.passwordKey]: pwd });
      log(
        `  ✓ ${s.mode === 'create' ? 'created' : 'set a new password for'}: ${title} (UPN and password to the admin env file, not shown)`,
      );
      return;
    }
    case 'campaignExclusion': {
      const u = await own();
      const result = await retry(() => excludeFromRegistrationCampaign(graph, u.id));
      log(`  ✓ ${result === 'added' ? 'excluded' : 'already excluded'}: ${title}`);
      return;
    }
    case 'delete': {
      // First out of the campaign's exclusions, so no exclusion outlives the account.
      await removeFromRegistrationCampaignExclusions(graph, s.id);
      try {
        await graph.request({ method: 'DELETE', path: `/users/${s.id}` });
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
      }
      ctx.writeEnv({ [spec.passwordKey]: '', ...(spec.totpKey ? { [spec.totpKey]: '' } : {}) });
      log(
        `  ✓ deleted: ${title} (password${spec.totpKey ? ' and TOTP seed' : ''} cleared from the admin env file)`,
      );
      return;
    }
  }
}

/**
 * Enables or disables both sign-in accounts (only accounts with the marker). Disabling revokes their sessions.
 * Used by `provision test-identities --disable` and the sign-in script. Returns how many changed.
 */
export async function setSignInAccountsEnabled(
  graph: GraphClient,
  accounts: readonly SignInAccountSpec[],
  enabled: boolean,
  only?: 1 | 2,
): Promise<{ changed: number; refused: string[]; missing: string[] }> {
  let changed = 0;
  const refused: string[] = [];
  const missing: string[] = [];
  for (const a of accounts) {
    if (only && a.n !== only) continue;
    const r = await setUserEnabled(graph, a.upn, enabled, isSignInAccount);
    if (r === 'changed') changed++;
    if (r === 'refused') refused.push(a.displayName);
    if (r === 'missing') missing.push(a.displayName);
  }
  return { changed, refused, missing };
}

/**
 * The two accounts at the UPNs the admin env stores (AF_TEST_SIGNIN_<n>_UPN), else at the derived ones for
 * `domain`; an account with neither is left out.
 */
export function storedSignInAccounts(
  env: Readonly<Record<string, string | undefined>>,
  domain: string | undefined,
): SignInAccountSpec[] {
  const derived = signInAccounts(domain ?? 'unset.invalid');
  return derived.flatMap((a) => {
    const upn = env[a.upnKey]?.trim() || (domain ? a.upn : undefined);
    return upn ? [{ ...a, upn }] : [];
  });
}
