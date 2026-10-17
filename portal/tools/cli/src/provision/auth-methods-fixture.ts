/**
 * The `auth-methods` test fixture: authentication methods the MFA and method-strength reports must classify — an SMS
 * number on AF-Test-User-02 (a fictitious North American 555-01xx number: reserved, it reaches nobody) and a
 * Temporary Access Pass on AF-Test-User-03 (one use, an hour; Graph shows the code once and it is dropped — never
 * stored or printed). Only on those base write-test targets, and only methods that look like provisioning's (the
 * fictitious number; any TAP on AF-Test-User-03) are removed. Plan (pure) and Graph I/O in one module: small.
 *
 * The tenant's authentication methods policy is never changed: when SMS or TAP is off there, Graph refuses and the
 * fixture prints ✗ with the reason.
 */
import { ApiError, type GraphClient } from '@adminforge/connectors';
import {
  isProvisionedAccount,
  isUnreadable,
  type DesiredFixtures,
  type FixtureOp,
  type Unreadable,
} from './fixtures-model';
import type { UserSpec } from './identities-plan';

export const AUTH_METHODS_SECTION = 'Test fixtures: authentication methods';
/** NANP fictitious range 555-0100…0199 (Seattle area code): never a real subscriber. */
export const FIXTURE_PHONE = '+1 2065550142';
const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

export interface AuthMethodsState {
  sms?: {
    user: AuthUser;
    phones: Array<{ id: string; phoneNumber?: string | null; phoneType?: string | null }>;
  };
  tap?: { user: AuthUser; passes: Array<{ id: string }> };
}
interface AuthUser {
  id: string;
  userPrincipalName: string;
  displayName?: string;
  employeeType?: string | null;
}

/** Steps name the user by UPN: the base targets may be created earlier in the same run. */
export type AuthMethodsStep =
  | { op: 'addPhone'; upn: string }
  | { op: 'addTap'; upn: string }
  | { op: 'deletePhone'; upn: string; methodId: string }
  | { op: 'deleteTap'; upn: string; methodId: string };

// Each operation resolves what it needs and fails on its own: one refusal doesn't stop the others.
const base = { fixture: 'auth-methods', section: AUTH_METHODS_SECTION, independent: true } as const;
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
  s: AuthMethodsStep,
  changes: string[] = [],
): FixtureOp => ({
  ...base,
  kind: 'authMethods',
  action,
  title,
  step: s,
  ...(changes.length ? { changes } : {}),
});

/** The base targets the methods go on: AF-Test-User-02 (SMS) and AF-Test-User-03 (TAP). */
export const authMethodTargets = (d: DesiredFixtures) => {
  const byNo = (n: string) => d.licensed.find((u) => new RegExp(`^af-test-user-${n}@`, 'i').test(u.upn))!;
  return { sms: byNo('02'), tap: byNo('03') };
};

/** Pure: the auth-methods fixture's operations. */
export function planAuthMethods(
  d: DesiredFixtures,
  s: AuthMethodsState | Unreadable | undefined,
  remove: boolean,
): FixtureOp[] {
  if (isUnreadable(s))
    return [blocked('SMS and Temporary Access Pass methods on AF-Test users', s.unreadable)];
  if (!s) return [];
  const t = authMethodTargets(d);
  const smsTitle = `${t.sms.displayName}: SMS ${FIXTURE_PHONE.replace(/\d{4}$/, 'xxxx')} (fictitious 555-01xx number)`;
  const tapTitle = `${t.tap.displayName}: Temporary Access Pass (one use, 60 minutes; code never shown)`;
  const ops: FixtureOp[] = [];
  const own = (spec: UserSpec, u?: AuthUser) => !!u && isProvisionedAccount(spec, u);
  const after = ['after the test identities create the user'];
  // SMS.
  if (!s.sms) {
    if (!remove) ops.push(step('create', smsTitle, { op: 'addPhone', upn: t.sms.upn }, after));
  } else if (!own(t.sms, s.sms.user)) {
    if (!remove) ops.push(blocked(smsTitle, 'the account is not provisioning’s — left alone'));
  } else {
    const ours = s.sms.phones.filter((p) => digits(p.phoneNumber) === digits(FIXTURE_PHONE));
    if (remove)
      for (const p of ours)
        ops.push(step('delete', smsTitle, { op: 'deletePhone', upn: t.sms.upn, methodId: p.id }));
    else if (ours.length) ops.push({ ...base, kind: 'note', action: 'noop', title: smsTitle });
    else if (s.sms.phones.some((p) => (p.phoneType ?? '').toLowerCase() === 'mobile'))
      ops.push(blocked(smsTitle, 'the user already has another mobile number — left alone'));
    else ops.push(step('create', smsTitle, { op: 'addPhone', upn: t.sms.upn }));
  }
  // Temporary Access Pass.
  const dropped = ['the pass Graph returns is dropped at once'];
  if (!s.tap) {
    if (!remove) ops.push(step('create', tapTitle, { op: 'addTap', upn: t.tap.upn }, [...after, ...dropped]));
  } else if (!own(t.tap, s.tap.user)) {
    if (!remove) ops.push(blocked(tapTitle, 'the account is not provisioning’s — left alone'));
  } else if (remove)
    for (const p of s.tap.passes)
      ops.push(step('delete', tapTitle, { op: 'deleteTap', upn: t.tap.upn, methodId: p.id }));
  else
    ops.push(
      s.tap.passes.length
        ? { ...base, kind: 'note', action: 'noop', title: tapTitle }
        : step('create', tapTitle, { op: 'addTap', upn: t.tap.upn }, dropped),
    );
  return ops;
}

const USER_SELECT = 'id,userPrincipalName,displayName,employeeType';

async function user(graph: GraphClient, upn: string): Promise<AuthUser | undefined> {
  try {
    return (
      await graph.request<AuthUser>({
        path: `/users/${encodeURIComponent(upn)}`,
        query: { $select: USER_SELECT },
      })
    ).data;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return undefined;
    throw err;
  }
}

/** Reads the two users' phone methods and passes. Read-only. */
export async function readAuthMethodsState(
  graph: GraphClient,
  d: DesiredFixtures,
): Promise<AuthMethodsState> {
  const t = authMethodTargets(d);
  const state: AuthMethodsState = {};
  const sms = await user(graph, t.sms.upn);
  if (sms)
    state.sms = {
      user: sms,
      phones: isProvisionedAccount(t.sms, sms)
        ? await graph.all({ path: `/users/${sms.id}/authentication/phoneMethods` })
        : [],
    };
  const tap = await user(graph, t.tap.upn);
  if (tap)
    state.tap = {
      user: tap,
      passes: isProvisionedAccount(t.tap, tap)
        ? (
            await graph.all<{ id: string }>({
              path: `/users/${tap.id}/authentication/temporaryAccessPassMethods`,
            })
          ).map((p) => ({ id: p.id }))
        : [],
    };
  return state;
}

/** Applies one auth-methods operation. Throws ApiError on a Graph refusal. The TAP code is never kept. */
export async function applyAuthMethodsStep(
  s: AuthMethodsStep,
  title: string,
  d: DesiredFixtures,
  ctx: { graph: GraphClient; log: (line: string) => void; retry: <T>(fn: () => Promise<T>) => Promise<T> },
): Promise<void> {
  const { graph, log, retry } = ctx;
  const t = authMethodTargets(d);
  const spec = [t.sms, t.tap].find((u) => u.upn === s.upn)!;
  const u = await retry(
    async () =>
      (await user(graph, s.upn)) ??
      Promise.reject(new ApiError(404, 'Request_ResourceNotFound', `${spec.displayName} is not visible yet`)),
  );
  if (!isProvisionedAccount(spec, u))
    throw new ApiError(
      409,
      'NotProvisioned',
      `${spec.displayName} was not created by provisioning; left alone`,
    );
  const gone = (err: unknown) => err instanceof ApiError && err.status === 404;
  switch (s.op) {
    case 'addPhone':
      await retry(() =>
        graph.request({
          method: 'POST',
          path: `/users/${u.id}/authentication/phoneMethods`,
          body: { phoneNumber: FIXTURE_PHONE, phoneType: 'mobile' },
        }),
      );
      log(`  ✓ added: ${title}`);
      return;
    case 'addTap':
      // Graph answers with the pass itself: dropped here, never stored, logged or printed.
      await retry(() =>
        graph.request({
          method: 'POST',
          path: `/users/${u.id}/authentication/temporaryAccessPassMethods`,
          body: { lifetimeInMinutes: 60, isUsableOnce: true },
        }),
      );
      log(`  ✓ added: ${title}`);
      return;
    case 'deletePhone':
    case 'deleteTap':
      try {
        await graph.request({
          method: 'DELETE',
          path: `/users/${u.id}/authentication/${s.op === 'deletePhone' ? 'phoneMethods' : 'temporaryAccessPassMethods'}/${s.methodId}`,
        });
      } catch (err) {
        if (!gone(err)) throw err;
      }
      log(`  ✓ removed: ${title}`);
      return;
  }
}
