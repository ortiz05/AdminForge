/**
 * The `apps` test fixture (catalogue and pure plan): app registrations whose problems the app reports must find —
 * a secret and a certificate about to expire, long-lived and several secrets, a risky configuration (an http
 * redirect URI, implicit grant, public client, personal accounts, Mail.ReadWrite requested but never granted), an
 * app without an owner, and a SAML enterprise app (non-gallery template) whose signing certificate expires within a
 * month. None is ever granted a permission, consented or given a role. Secrets are created and dropped on the spot:
 * never stored, never printed; certificates are throwaway (provision/self-signed-certificate.ts) with the key never
 * kept. Graph I/O: provision/apps-fixture-io.ts.
 *
 * Expiry stays true over time: each run checks that the expiring credentials still expire soon (and haven't yet),
 * and replaces them when they don't; the hygiene app keeps its three named secrets. Ownership: the app's `notes`
 * carry the marker and the name is the catalogue's; anything else with the name is refused, never changed or removed.
 */
import { isUnreadable, type DesiredFixtures, type FixtureOp, type Unreadable } from './fixtures-model';
import { TESTER_MARKER } from './identities-plan';

export const APPS_SECTION = 'Test fixtures: app registrations';
/** Every fixture app's `notes`: the marker, and that it is never granted anything. */
export const APPS_NOTES = `${TESTER_MARKER} fixture (apps), created by \`adminforge provision test-identities\`. Never granted any permission; safe to delete.`;
/** Microsoft's "non-gallery application" template (the same id in every tenant). */
export const SAML_TEMPLATE_ID = '8adf8e6e-67b2-4cf2-a259-e3dc5476c621';
/** Microsoft Graph and its Mail.ReadWrite application permission (well-known ids) — requested, never granted. */
export const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
export const MAIL_READWRITE_ROLE = 'e2a3a72e-5f79-4c64-b1b1-878b674786c9';

export type FixtureAppKey = 'expiring' | 'hygiene' | 'risky' | 'noOwner';

export interface FixtureAppSpec {
  key: FixtureAppKey;
  displayName: string;
  kind: string;
  /** Owned by AF-Test-User-01 (the no-owner app has none). */
  owner: boolean;
  /** Settings kept as listed (besides the notes). */
  body: Record<string, unknown>;
  /** Named secrets kept present and unexpired, created with this lifetime in days. */
  secrets: Array<{ displayName: string; days: number }>;
  /** A secret that must keep expiring within `withinDays` (replaced by a new one of `days` when it doesn't). */
  expiringSecret?: { displayName: string; days: number; withinDays: number };
  /** A certificate that must keep expiring within `withinDays`. */
  expiringCertificate?: { days: number; withinDays: number };
}

/** The risky app: what the app-registration-risks report looks for. */
export const RISKY_BODY = {
  signInAudience: 'AzureADandPersonalMicrosoftAccount',
  api: { requestedAccessTokenVersion: 2 },
  isFallbackPublicClient: true,
  web: {
    redirectUris: ['http://af-test-risky.example.com/signin'],
    implicitGrantSettings: { enableAccessTokenIssuance: true, enableIdTokenIssuance: true },
  },
  requiredResourceAccess: [
    { resourceAppId: GRAPH_APP_ID, resourceAccess: [{ id: MAIL_READWRITE_ROLE, type: 'Role' }] },
  ],
} as const;
/** Graph may refuse personal accounts with this configuration; multi-tenant is the next riskiest audience. */
export const RISKY_FALLBACK_AUDIENCE = 'AzureADMultipleOrgs';

export const FIXTURE_APPS: readonly FixtureAppSpec[] = [
  {
    key: 'expiring',
    displayName: 'AF-Test-App-Expiring',
    kind: 'secret and certificate about to expire',
    owner: true,
    body: {},
    secrets: [],
    expiringSecret: { displayName: 'AF-Test 7-day secret', days: 7, withinDays: 30 },
    expiringCertificate: { days: 20, withinDays: 45 },
  },
  {
    key: 'hygiene',
    displayName: 'AF-Test-App-Hygiene',
    kind: 'a 2-year secret and three secrets',
    owner: true,
    body: {},
    secrets: [
      { displayName: 'AF-Test 2-year secret', days: 730 },
      { displayName: 'AF-Test 1-year secret', days: 365 },
      { displayName: 'AF-Test 6-month secret', days: 180 },
    ],
  },
  {
    key: 'risky',
    displayName: 'AF-Test-App-Risky',
    kind: 'http redirect, implicit grant, public client, personal or multi-tenant audience, Mail.ReadWrite requested — not granted, no owner',
    // No owner: nobody can add a credential or consent through ownership; a working OAuth client is risky enough.
    owner: false,
    body: RISKY_BODY,
    secrets: [],
  },
  {
    key: 'noOwner',
    displayName: 'AF-Test-App-NoOwner',
    kind: 'no owner',
    owner: false,
    body: {},
    secrets: [],
  },
];

export const SAML_APP = {
  displayName: 'AF-Test-SAML-01',
  /** Signing certificate lifetime, and how soon it must keep expiring. */
  signingCertificate: { days: 25, withinDays: 45 },
} as const;

export interface Credential {
  keyId: string;
  displayName?: string | null;
  startDateTime?: string | null;
  endDateTime?: string | null;
  usage?: string | null;
  type?: string | null;
}

export interface FixtureAppState {
  id: string;
  appId: string;
  displayName: string;
  notes?: string | null;
  signInAudience?: string;
  isFallbackPublicClient?: boolean | null;
  web?: { redirectUris?: string[]; implicitGrantSettings?: Record<string, boolean | undefined> } | null;
  requiredResourceAccess?: Array<{
    resourceAppId: string;
    resourceAccess: Array<{ id: string; type: string }>;
  }>;
  passwordCredentials: Credential[];
  keyCredentials: Credential[];
  ownerIds: string[];
  /**
   * Service principals for this app (a fixture app has none — except the SAML app, which is one): someone consented
   * to it or added it as an enterprise app. Read for provisioning's apps only.
   */
  servicePrincipalIds?: string[];
}

export interface AppsState {
  /** When the state was read (expiry checks). */
  readAt: string;
  apps: Partial<Record<FixtureAppKey | 'saml', FixtureAppState[]>>;
  /** The SAML app's service principal. */
  samlSp?: {
    id: string;
    notes?: string | null;
    preferredSingleSignOnMode?: string | null;
    /** Kept true: nobody is assigned, so nobody can sign in to it. */
    appRoleAssignmentRequired?: boolean | null;
    keyCredentials: Credential[];
    /** Permissions granted to it (application permissions and delegated grants): none, ever. */
    grants: number;
    /** Users, groups or apps assigned to it: none, ever. */
    assignments: number;
  };
  /** AF-Test-User-01's id when it is the test identities' own (the owner provisioning gives some apps). */
  ownerUserId?: string;
}

export type AppsStep =
  | {
      op: 'app';
      key: FixtureAppKey;
      create: boolean;
      patch?: Record<string, unknown>;
      addOwner: boolean;
      /** Owners provisioning added itself (AF-Test-User-01) to an app that must be ownerless. */
      removeOwnerIds?: string[];
      addSecrets: Array<{ displayName: string; days: number }>;
      removeSecretKeyIds: string[];
      replaceCertificate?: { days: number };
    }
  | { op: 'saml'; create: boolean; markServicePrincipal: boolean; signingCertificate?: { days: number } }
  | { op: 'delete'; id: string };

// Each operation resolves what it needs and fails on its own: one refusal doesn't stop the others.
const base = { fixture: 'apps', section: APPS_SECTION, independent: true } as const;
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
  s: AppsStep,
  changes: string[] = [],
): FixtureOp => ({
  ...base,
  kind: 'apps',
  action,
  title,
  step: s,
  ...(changes.length ? { changes } : {}),
});

/** Whether an app is provisioning's: its catalogue name and the marker in its notes. */
export const isFixtureApp = (a: Pick<FixtureAppState, 'notes'>) => (a.notes ?? '').includes(TESTER_MARKER);

const DAY = 86_400_000;
const endsIn = (c: Credential, now: number) => (c.endDateTime ? new Date(c.endDateTime).getTime() - now : -1);
/** A credential that hasn't expired yet and expires within `days`. */
const expiringWithin = (c: Credential, now: number, days: number) =>
  endsIn(c, now) > 0 && endsIn(c, now) <= days * DAY;

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

/** Pure: what differs from the risky app's settings (personal accounts or the multi-tenant fallback both count). */
export function riskyPatch(a: FixtureAppState): Record<string, unknown> | undefined {
  const patch: Record<string, unknown> = {};
  if (![RISKY_BODY.signInAudience, RISKY_FALLBACK_AUDIENCE].includes(a.signInAudience as never))
    patch.signInAudience = RISKY_BODY.signInAudience;
  if (a.isFallbackPublicClient !== true) patch.isFallbackPublicClient = true;
  const implicit = a.web?.implicitGrantSettings ?? {};
  if (
    !sameList(a.web?.redirectUris, RISKY_BODY.web.redirectUris) ||
    implicit.enableAccessTokenIssuance !== true ||
    implicit.enableIdTokenIssuance !== true
  )
    patch.web = RISKY_BODY.web;
  const graph = (a.requiredResourceAccess ?? []).find((r) => r.resourceAppId === GRAPH_APP_ID);
  const requested = (graph?.resourceAccess ?? []).some(
    (r) => r.id === MAIL_READWRITE_ROLE && r.type === 'Role',
  );
  if (!requested || (a.requiredResourceAccess ?? []).length !== 1 || graph?.resourceAccess.length !== 1)
    patch.requiredResourceAccess = RISKY_BODY.requiredResourceAccess;
  return Object.keys(patch).length ? patch : undefined;
}

/** Pure: the apps fixture's operations (`provision test-identities`, `provision status`, `--remove-fixtures`). */
export function planApps(
  d: DesiredFixtures,
  s: AppsState | Unreadable | undefined,
  remove: boolean,
): FixtureOp[] {
  if (isUnreadable(s)) return [blocked('AF-Test app registrations and the SAML app', s.unreadable)];
  if (!s) return [];
  const now = new Date(s.readAt).getTime();
  const ops: FixtureOp[] = [];
  const owner = d.licensed.find((u) => /^af-test-user-01@/i.test(u.upn))?.displayName ?? 'AF-Test-User-01';

  for (const spec of FIXTURE_APPS) {
    const title = `${spec.displayName} (${spec.kind})`;
    const found = s.apps[spec.key] ?? [];
    const ours = found.filter(isFixtureApp);
    if (remove) {
      for (const a of ours) ops.push(step('delete', title, { op: 'delete', id: a.id }));
      continue;
    }
    if (found.length && !ours.length) {
      ops.push(
        blocked(
          title,
          'an app with this name exists without the marker in its notes — not created by provisioning, left alone',
        ),
      );
      continue;
    }
    if (ours.length > 1) {
      ops.push(blocked(title, `${ours.length} apps with this name carry the marker — delete the extra ones`));
      continue;
    }
    const a = ours[0];
    if (a?.servicePrincipalIds?.length) {
      ops.push(
        blocked(
          title,
          `has ${a.servicePrincipalIds.length} service principal(s): someone consented to it or added it as an enterprise app — delete them; fixture apps are never granted anything`,
        ),
      );
      continue;
    }
    const changes: string[] = [];
    const addSecrets: Array<{ displayName: string; days: number }> = [];
    const removeSecretKeyIds: string[] = [];
    for (const sec of spec.secrets) {
      const named = (a?.passwordCredentials ?? []).filter((c) => c.displayName === sec.displayName);
      if (!named.some((c) => endsIn(c, now) > 0)) {
        addSecrets.push(sec);
        removeSecretKeyIds.push(...named.map((c) => c.keyId));
        changes.push(`+ secret "${sec.displayName}" (${sec.days} days, not stored)`);
      }
    }
    if (spec.expiringSecret) {
      const e = spec.expiringSecret;
      if (!(a?.passwordCredentials ?? []).some((c) => expiringWithin(c, now, e.withinDays))) {
        addSecrets.push({ displayName: e.displayName, days: e.days });
        removeSecretKeyIds.push(...(a?.passwordCredentials ?? []).map((c) => c.keyId));
        changes.push(
          `secret expiring in ${e.days} days (not stored)${a?.passwordCredentials.length ? ', replacing the old one' : ''}`,
        );
      }
    }
    let replaceCertificate: { days: number } | undefined;
    if (spec.expiringCertificate) {
      const e = spec.expiringCertificate;
      if (!(a?.keyCredentials ?? []).some((c) => expiringWithin(c, now, e.withinDays))) {
        replaceCertificate = { days: e.days };
        changes.push(`certificate expiring in ${e.days} days (throwaway, key not kept)`);
      }
    }
    const patch = a && spec.key === 'risky' ? riskyPatch(a) : undefined;
    if (patch) changes.push(`settings → ${Object.keys(patch).join(', ')}`);
    const addOwner = spec.owner && (!a || a.ownerIds.length === 0);
    if (addOwner) changes.push(`owner ${owner}`);
    // An app that must be ownerless: provisioning takes back the owner it added; anyone else is for a person to remove.
    const removeOwnerIds = !spec.owner && a ? a.ownerIds.filter((id) => id === s.ownerUserId) : [];
    const otherOwners = !spec.owner && a ? a.ownerIds.length - removeOwnerIds.length : 0;
    if (removeOwnerIds.length) changes.push(`− owner ${owner} (it stays ownerless)`);
    if (otherOwners) {
      ops.push(
        blocked(
          title,
          `has ${otherOwners} owner(s) provisioning didn't add — remove them to keep it ownerless`,
        ),
      );
      continue;
    }
    if (a && !addSecrets.length && !replaceCertificate && !patch && !addOwner && !removeOwnerIds.length) {
      ops.push({ ...base, kind: 'note', action: 'noop', title });
      continue;
    }
    ops.push(
      step(
        a ? 'update' : 'create',
        title,
        {
          op: 'app',
          key: spec.key,
          create: !a,
          ...(patch ? { patch } : {}),
          addOwner,
          ...(removeOwnerIds.length ? { removeOwnerIds } : {}),
          addSecrets,
          removeSecretKeyIds,
          ...(replaceCertificate ? { replaceCertificate } : {}),
        },
        a ? changes : ['never granted any permission', ...changes],
      ),
    );
  }

  // The SAML enterprise app.
  const samlTitle = `${SAML_APP.displayName} (SAML app, signing certificate expiring within a month)`;
  const found = s.apps.saml ?? [];
  const ours = found.filter(isFixtureApp);
  if (remove) {
    for (const a of ours) ops.push(step('delete', samlTitle, { op: 'delete', id: a.id }));
    return ops;
  }
  if (found.length && !ours.length)
    ops.push(blocked(samlTitle, 'an app with this name exists without the marker — left alone'));
  else if (ours.length > 1)
    ops.push(blocked(samlTitle, `${ours.length} apps with this name carry the marker`));
  else if (s.samlSp && (s.samlSp.grants || s.samlSp.assignments))
    ops.push(
      blocked(
        samlTitle,
        `its service principal has ${s.samlSp.grants} permission grant(s) and ${s.samlSp.assignments} assignment(s) — remove them; the fixture app is never granted or assigned anything`,
      ),
    );
  else {
    const sp = s.samlSp;
    const markServicePrincipal =
      !!ours[0] &&
      (!sp ||
        !isFixtureApp(sp) ||
        sp.preferredSingleSignOnMode !== 'saml' ||
        sp.appRoleAssignmentRequired !== true);
    const cert = SAML_APP.signingCertificate;
    const needsCert =
      !ours[0] ||
      !(sp?.keyCredentials ?? []).some(
        (c) => (c.usage ?? '').toLowerCase() === 'verify' && expiringWithin(c, now, cert.withinDays),
      );
    if (ours[0] && !markServicePrincipal && !needsCert)
      ops.push({ ...base, kind: 'note', action: 'noop', title: samlTitle });
    else
      ops.push(
        step(
          ours[0] ? 'update' : 'create',
          samlTitle,
          {
            op: 'saml',
            create: !ours[0],
            markServicePrincipal: markServicePrincipal || !ours[0],
            ...(needsCert ? { signingCertificate: { days: cert.days } } : {}),
          },
          [
            ...(ours[0] ? [] : ['from the non-gallery template; no users assigned']),
            ...(markServicePrincipal
              ? ['single sign-on mode SAML, user assignment required (nobody assigned)']
              : []),
            ...(needsCert ? [`signing certificate expiring in ${cert.days} days`] : []),
          ],
        ),
      );
  }
  return ops;
}
