/**
 * Microsoft Graph I/O for the `apps` test fixture (provision/apps-fixture-plan.ts decides): reads the fixture apps,
 * their owners and credentials and the SAML app's service principal; applies one operation (`applyAppsStep`). Secret
 * values Graph returns are dropped at once — never stored, logged or printed; certificates are throwaway with the key
 * never kept. No permission is ever granted to these apps (no consent, no app role assignment).
 */
import { ApiError, type GraphClient } from '@adminforge/connectors';
import {
  APPS_NOTES,
  FIXTURE_APPS,
  RISKY_FALLBACK_AUDIENCE,
  SAML_APP,
  SAML_TEMPLATE_ID,
  isFixtureApp,
  type AppsState,
  type AppsStep,
  type FixtureAppState,
} from './apps-fixture-plan';
import { odata } from './entra-io';
import { isProvisionedAccount, type DesiredFixtures } from './fixtures-model';
import { selfSignedCertificate } from './self-signed-certificate';

const APP_SELECT =
  'id,appId,displayName,notes,signInAudience,isFallbackPublicClient,web,requiredResourceAccess,passwordCredentials,keyCredentials';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const DAY = 86_400_000;

const notVisible = (what: string) =>
  new ApiError(404, 'Request_ResourceNotFound', `${what} is not visible yet (directory replication)`);
const isAlreadyExists = (err: unknown) =>
  err instanceof ApiError && (err.status === 409 || /already exist/i.test(`${err.code} ${err.message}`));

async function appsNamed(
  graph: GraphClient,
  displayName: string,
  withSps: boolean,
): Promise<FixtureAppState[]> {
  const found = await graph.all<Omit<FixtureAppState, 'ownerIds'>>({
    path: '/applications',
    query: { $filter: `displayName eq ${odata(displayName)}`, $select: APP_SELECT },
  });
  const out: FixtureAppState[] = [];
  for (const a of found) {
    const ours = isFixtureApp(a);
    out.push({
      ...a,
      passwordCredentials: a.passwordCredentials ?? [],
      keyCredentials: a.keyCredentials ?? [],
      ownerIds: ours
        ? (
            await graph.all<{ id: string }>({
              path: `/applications/${a.id}/owners`,
              query: { $select: 'id' },
            })
          ).map((o) => o.id)
        : [],
      // A fixture app never has a service principal (no consent, no enterprise app) — the SAML app aside.
      ...(ours && withSps ? { servicePrincipalIds: await servicePrincipalIds(graph, a.appId) } : {}),
    });
  }
  return out;
}

const servicePrincipalIds = async (graph: GraphClient, appId: string) =>
  (
    await graph.all<{ id: string }>({
      path: '/servicePrincipals',
      query: { $filter: `appId eq ${odata(appId)}`, $select: 'id' },
    })
  ).map((sp) => sp.id);

/** Reads what the apps fixture compares against. Read-only. */
export async function readAppsState(
  graph: GraphClient,
  desired: DesiredFixtures,
  now: Date = new Date(),
): Promise<AppsState> {
  const state: AppsState = { readAt: now.toISOString(), apps: {} };
  for (const spec of FIXTURE_APPS) state.apps[spec.key] = await appsNamed(graph, spec.displayName, true);
  state.apps.saml = await appsNamed(graph, SAML_APP.displayName, false);
  const saml = state.apps.saml.filter(isFixtureApp);
  if (saml.length === 1) {
    const { data } = await graph.request<{ value?: NonNullable<AppsState['samlSp']>[] }>({
      path: '/servicePrincipals',
      query: {
        $filter: `appId eq ${odata(saml[0]!.appId)}`,
        $select: 'id,notes,preferredSingleSignOnMode,appRoleAssignmentRequired,keyCredentials',
      },
    });
    const sp = data.value?.[0];
    if (sp) {
      // Never granted or assigned anything: its application permissions, delegated grants and assignments.
      const count = async (path: string, query?: Record<string, string>) =>
        (await graph.all<{ id: string }>({ path, ...(query ? { query } : {}) })).length;
      const grants =
        (await count(`/servicePrincipals/${sp.id}/appRoleAssignments`)) +
        (await count('/oauth2PermissionGrants', { $filter: `clientId eq ${odata(sp.id)}` }));
      const assignments = await count(`/servicePrincipals/${sp.id}/appRoleAssignedTo`);
      state.samlSp = { ...sp, keyCredentials: sp.keyCredentials ?? [], grants, assignments };
    }
  }
  const owner = desired.licensed.find((u) => /^af-test-user-01@/i.test(u.upn));
  if (owner) {
    const u = await graph
      .request<{ id: string; userPrincipalName: string; displayName?: string; employeeType?: string | null }>(
        {
          path: `/users/${encodeURIComponent(owner.upn)}`,
          query: { $select: 'id,userPrincipalName,displayName,employeeType' },
        },
      )
      .then(
        (r) => r.data,
        () => undefined,
      );
    if (u && isProvisionedAccount(owner, u)) state.ownerUserId = u.id;
  }
  return state;
}

export interface AppsApplyContext {
  graph: GraphClient;
  log: (line: string) => void;
  retry: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => Date;
}

/** Applies one apps operation. Throws ApiError on a Graph refusal (the caller prints ✗ and goes on). */
export async function applyAppsStep(
  step: AppsStep,
  title: string,
  desired: DesiredFixtures,
  ctx: AppsApplyContext,
): Promise<void> {
  const { graph, log, retry } = ctx;
  const now = ctx.now?.() ?? new Date();
  const ownApp = (displayName: string) =>
    retry(async () => {
      const ours = (await appsNamed(graph, displayName, false)).filter(isFixtureApp);
      if (ours.length > 1)
        throw new ApiError(409, 'Ambiguous', `${ours.length} apps named ${displayName} carry the marker`);
      return ours[0] ?? Promise.reject(notVisible(displayName));
    });
  const addSecret = (id: string, displayName: string, days: number) =>
    retry(async () => {
      // The secret Graph returns is dropped here: never stored, logged or printed.
      await graph.request({
        method: 'POST',
        path: `/applications/${id}/addPassword`,
        body: {
          passwordCredential: {
            displayName,
            endDateTime: new Date(now.getTime() + days * DAY).toISOString(),
          },
        },
      });
    });

  switch (step.op) {
    case 'app': {
      const spec = FIXTURE_APPS.find((a) => a.key === step.key)!;
      let id: string;
      if (step.create) {
        const body = { displayName: spec.displayName, notes: APPS_NOTES, ...spec.body };
        try {
          id = (await graph.request<{ id: string }>({ method: 'POST', path: '/applications', body })).data.id;
        } catch (err) {
          // Personal Microsoft accounts don't allow every risky setting: the multi-tenant audience instead.
          if (!(step.key === 'risky' && err instanceof ApiError && err.status === 400)) throw err;
          id = (
            await graph.request<{ id: string }>({
              method: 'POST',
              path: '/applications',
              body: { ...body, signInAudience: RISKY_FALLBACK_AUDIENCE, api: undefined },
            })
          ).data.id;
          log(`      … personal accounts refused for this configuration; created multi-tenant instead`);
        }
      } else id = (await ownApp(spec.displayName)).id;
      const appId = id;
      if (step.patch) {
        const patch = step.patch;
        await retry(() => graph.request({ method: 'PATCH', path: `/applications/${appId}`, body: patch }));
      }
      if (step.addOwner || step.removeOwnerIds?.length) {
        const spec = desired.licensed.find((u) => /^af-test-user-01@/i.test(u.upn))!;
        const owner = await retry(async () => {
          try {
            return (
              await graph.request<{
                id: string;
                userPrincipalName: string;
                displayName?: string;
                employeeType?: string | null;
              }>({
                path: `/users/${encodeURIComponent(spec.upn)}`,
                query: { $select: 'id,userPrincipalName,displayName,employeeType' },
              })
            ).data;
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) return Promise.reject(notVisible(spec.upn));
            throw err;
          }
        });
        if (!isProvisionedAccount(spec, owner))
          throw new ApiError(
            409,
            'NotProvisioned',
            `${spec.displayName} is not provisioning's account; left alone`,
          );
        if (step.addOwner)
          await retry(async () => {
            try {
              await graph.request({
                method: 'POST',
                path: `/applications/${appId}/owners/$ref`,
                body: { '@odata.id': `${GRAPH}/directoryObjects/${owner.id}` },
              });
            } catch (err) {
              if (!isAlreadyExists(err)) throw err;
            }
          });
        // Only the owner provisioning added (the plan checked; re-checked here by id).
        for (const id of (step.removeOwnerIds ?? []).filter((x) => x === owner.id))
          try {
            await graph.request({ method: 'DELETE', path: `/applications/${appId}/owners/${id}/$ref` });
          } catch (err) {
            if (!(err instanceof ApiError && err.status === 404)) throw err;
          }
      }
      for (const keyId of step.removeSecretKeyIds)
        await graph.request({
          method: 'POST',
          path: `/applications/${appId}/removePassword`,
          body: { keyId },
        });
      for (const s of step.addSecrets) await addSecret(appId, s.displayName, s.days);
      if (step.replaceCertificate) {
        const der = selfSignedCertificate(
          spec.displayName,
          now,
          new Date(now.getTime() + step.replaceCertificate.days * DAY),
        );
        await retry(() =>
          graph.request({
            method: 'PATCH',
            path: `/applications/${appId}`,
            body: {
              keyCredentials: [
                {
                  type: 'AsymmetricX509Cert',
                  usage: 'Verify',
                  key: der.toString('base64'),
                  displayName: `CN=${spec.displayName}`,
                },
              ],
            },
          }),
        );
      }
      log(`  ✓ ${step.create ? 'created' : 'updated'}: ${title}`);
      return;
    }
    case 'saml': {
      let app: { id: string; appId: string };
      let spId: string;
      if (step.create) {
        const { data } = await graph.request<{
          application: { id: string; appId: string };
          servicePrincipal: { id: string };
        }>({
          method: 'POST',
          path: `/applicationTemplates/${SAML_TEMPLATE_ID}/instantiate`,
          body: { displayName: SAML_APP.displayName },
        });
        app = data.application;
        spId = data.servicePrincipal.id;
        // Marked at once; an app that can't be marked is deleted again (with its service principal), so no unmarked
        // fixture app is left behind.
        const appObjectId = app.id;
        try {
          await retry(() =>
            graph.request({
              method: 'PATCH',
              path: `/applications/${appObjectId}`,
              body: { notes: APPS_NOTES },
            }),
          );
        } catch (err) {
          await graph
            .request({ method: 'DELETE', path: `/applications/${appObjectId}` })
            .catch(() => undefined);
          throw err;
        }
      } else {
        app = await ownApp(SAML_APP.displayName);
        spId = await retry(async () => {
          const { data } = await graph.request<{ value?: Array<{ id: string }> }>({
            path: '/servicePrincipals',
            query: { $filter: `appId eq ${odata(app.appId)}`, $select: 'id' },
          });
          return (
            data.value?.[0]?.id ?? Promise.reject(notVisible(`${SAML_APP.displayName} service principal`))
          );
        });
      }
      if (step.markServicePrincipal)
        await retry(() =>
          graph.request({
            method: 'PATCH',
            path: `/servicePrincipals/${spId}`,
            body: { notes: APPS_NOTES, preferredSingleSignOnMode: 'saml', appRoleAssignmentRequired: true },
          }),
        );
      if (step.signingCertificate) {
        const days = step.signingCertificate.days;
        const { data } = await retry(() =>
          graph.request<{ thumbprint?: string }>({
            method: 'POST',
            path: `/servicePrincipals/${spId}/addTokenSigningCertificate`,
            body: {
              displayName: `CN=${SAML_APP.displayName}`,
              endDateTime: new Date(now.getTime() + days * DAY).toISOString(),
            },
          }),
        );
        if (data.thumbprint) {
          const thumbprint = data.thumbprint;
          await retry(() =>
            graph.request({
              method: 'PATCH',
              path: `/servicePrincipals/${spId}`,
              body: { preferredTokenSigningKeyThumbprint: thumbprint },
            }),
          );
        }
      }
      log(`  ✓ ${step.create ? 'created' : 'updated'}: ${title}`);
      return;
    }
    case 'delete': {
      try {
        await graph.request({ method: 'DELETE', path: `/applications/${step.id}` });
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
      }
      log(`  ✓ removed: ${title}`);
      return;
    }
  }
}
