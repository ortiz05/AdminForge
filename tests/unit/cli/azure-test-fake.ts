import { randomUUID } from 'node:crypto';

/**
 * In-memory stand-in for the slice of Entra token endpoint, Microsoft Graph, ARM and the Log Analytics query API
 * that `adminforge provision azure-test` uses. Synthetic data only (example.com, generated GUIDs). No network.
 */

type Json = Record<string, unknown>;

export interface AzureFakeOptions {
  tenantId: string;
  subscriptionId: string;
  provisioner: { clientId: string; secret: string };
  automation: { clientId: string; secret: string };
  testerUpn: string;
  /** PUT role assignment answers PrincipalNotFound this many times first (replication). */
  principalNotFound?: number;
  /** The workspace reports provisioningState "Creating" for this many GETs after the PUT. */
  creatingPolls?: number;
  /** Log Analytics answers 403 this many times before the role assignment "propagates". */
  laForbidden?: number;
  /** AzureActivity exists (else the query fails with 400 SemanticError, like a brand-new workspace). */
  activityRows?: number | null;
}

const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const armError = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function createAzureFake(opts: AzureFakeOptions) {
  const sub = `/subscriptions/${opts.subscriptionId}`;
  const automationSp = {
    id: randomUUID(),
    appId: opts.automation.clientId,
    displayName: 'AdminForge Automation [test]',
  };
  const tester = { id: randomUUID(), userPrincipalName: opts.testerUpn, displayName: 'AF Tester' };
  const resourceGroups = new Map<string, Json>(); // lower-case id → RG
  const workspaces = new Map<string, Json>();
  const diagnostics = new Map<string, Json>();
  const assignments: Array<{ id: string; name: string; properties: Json }> = [];
  const calls: string[] = [];
  const laQueries: string[] = [];
  let principalNotFound = opts.principalNotFound ?? 0;
  let creating = 0;
  let laForbidden = opts.laForbidden ?? 0;
  const pendingDeletes = new Map<string, number>(); // operation id → polls left

  function token(form: URLSearchParams) {
    const clientId = form.get('client_id');
    const secret = form.get('client_secret');
    const known =
      (clientId === opts.provisioner.clientId && secret === opts.provisioner.secret) ||
      (clientId === opts.automation.clientId && secret === opts.automation.secret);
    if (!known)
      return json(401, {
        error: 'invalid_client',
        error_description: 'AADSTS7000215: Invalid client secret provided.',
      });
    return json(200, {
      access_token: `${b64({ alg: 'none' })}.${b64({ appid: clientId, aud: form.get('scope') })}.sig`,
      expires_in: 3600,
    });
  }

  function graph(method: string, url: URL): Response {
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ''));
    if (method === 'GET' && path === '/servicePrincipals') {
      const m = /^appId eq '([^']*)'$/.exec(url.searchParams.get('$filter') ?? '');
      return json(200, { value: m && m[1] === automationSp.appId ? [automationSp] : [] });
    }
    const user = /^\/users\/(.+)$/.exec(path);
    if (method === 'GET' && user) {
      return user[1]!.toLowerCase() === tester.userPrincipalName.toLowerCase()
        ? json(200, tester)
        : armError(404, 'Request_ResourceNotFound', 'not found');
    }
    return armError(400, 'Unhandled', `fake Graph does not implement ${method} ${path}`);
  }

  function arm(method: string, url: URL, body: Json | undefined): Response {
    const path = decodeURIComponent(url.pathname);
    const key = path.toLowerCase();
    let m: RegExpExecArray | null;

    if ((m = /^\/operations\/(.+)$/.exec(path))) {
      const left = pendingDeletes.get(m[1]!) ?? 0;
      if (left > 0) {
        pendingDeletes.set(m[1]!, left - 1);
        return json(202, undefined, { location: url.toString() });
      }
      return json(200);
    }
    if (/\/providers\/microsoft\.authorization\/roleassignments$/i.test(path) && method === 'GET') {
      const scope = path
        .replace(/\/providers\/Microsoft\.Authorization\/roleAssignments$/i, '')
        .toLowerCase();
      const f = /^principalId eq '([^']*)'$/.exec(url.searchParams.get('$filter') ?? '');
      // Like ARM: assignments at, above and below the scope.
      return json(200, {
        value: assignments.filter(
          (a) =>
            (!f || a.properties.principalId === f[1]) &&
            (scope.startsWith(String(a.properties.scope).toLowerCase()) ||
              String(a.properties.scope).toLowerCase().startsWith(scope)),
        ),
      });
    }
    if ((m = /^(.+)\/providers\/Microsoft\.Authorization\/roleAssignments\/([^/]+)$/i.exec(path))) {
      const [, scope, name] = m;
      if (method === 'PUT') {
        if (principalNotFound > 0) {
          principalNotFound--;
          return armError(
            400,
            'PrincipalNotFound',
            `Principal ${String((body!.properties as Json).principalId)} does not exist in the directory.`,
          );
        }
        if (assignments.some((a) => a.name === name))
          return armError(409, 'RoleAssignmentExists', 'The role assignment already exists.');
        assignments.push({
          id: path,
          name: name!,
          properties: { ...(body!.properties as Json), scope: scope! },
        });
        return json(201, {});
      }
      if (method === 'DELETE') {
        const i = assignments.findIndex((a) => a.name === name);
        if (i < 0) return json(204);
        assignments.splice(i, 1);
        return json(200, {});
      }
    }
    if (/^\/subscriptions\/[^/]+\/providers\/microsoft\.insights\/diagnosticsettings\/[^/]+$/i.test(path)) {
      if (method === 'GET')
        return diagnostics.has(key)
          ? json(200, diagnostics.get(key))
          : armError(404, 'ResourceNotFound', 'The diagnostic setting does not exist.');
      if (method === 'PUT') {
        diagnostics.set(key, { id: path, name: path.split('/').pop(), ...body });
        return json(200, diagnostics.get(key));
      }
      if (method === 'DELETE') return diagnostics.delete(key) ? json(200) : json(204);
    }
    if (
      /^\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/providers\/microsoft\.operationalinsights\/workspaces\/[^/]+$/i.test(
        path,
      )
    ) {
      const rgKey = key.replace(/\/providers\/.*$/, '');
      if (!resourceGroups.has(rgKey))
        return armError(404, 'ResourceGroupNotFound', 'Resource group not found.');
      if (method === 'GET') {
        const ws = workspaces.get(key);
        if (!ws) return armError(404, 'ResourceNotFound', 'The workspace was not found.');
        if (creating > 0) {
          creating--;
          return json(200, {
            ...ws,
            properties: { ...(ws.properties as Json), provisioningState: 'Creating' },
          });
        }
        return json(200, ws);
      }
      if (method === 'PUT') {
        const existing = workspaces.get(key);
        const props = body!.properties as Json;
        const ws = {
          id: path,
          name: path.split('/').pop(),
          location: body!.location,
          tags: body!.tags,
          properties: {
            ...props,
            customerId: (existing?.properties as Json | undefined)?.customerId ?? randomUUID(),
            provisioningState: 'Succeeded',
          },
        };
        workspaces.set(key, ws);
        creating = existing ? 0 : (opts.creatingPolls ?? 0);
        return json(
          existing ? 200 : 201,
          creating ? { ...ws, properties: { ...ws.properties, provisioningState: 'Creating' } } : ws,
        );
      }
      if (method === 'DELETE') {
        if (url.searchParams.get('force') !== 'true')
          return armError(400, 'Unexpected', 'the fake expects force=true');
        return workspaces.delete(key) ? json(200) : json(204);
      }
    }
    if (/^\/subscriptions\/[^/]+\/resourcegroups\/[^/]+$/i.test(path)) {
      if (method === 'GET')
        return resourceGroups.has(key)
          ? json(200, resourceGroups.get(key))
          : armError(404, 'ResourceGroupNotFound', 'Resource group not found.');
      if (method === 'PUT') {
        const created = !resourceGroups.has(key);
        resourceGroups.set(key, {
          id: path,
          name: path.split('/').pop(),
          location: body!.location,
          tags: body!.tags,
        });
        return json(created ? 201 : 200, resourceGroups.get(key));
      }
      if (method === 'DELETE') {
        if (!resourceGroups.has(key))
          return armError(404, 'ResourceGroupNotFound', 'Resource group not found.');
        resourceGroups.delete(key);
        for (const k of [...workspaces.keys()]) if (k.startsWith(`${key}/`)) workspaces.delete(k);
        for (let i = assignments.length - 1; i >= 0; i--)
          if (String(assignments[i]!.properties.scope).toLowerCase().startsWith(`${key}/`))
            assignments.splice(i, 1);
        const op = randomUUID();
        pendingDeletes.set(op, 2);
        return json(202, undefined, { location: `https://management.azure.com/operations/${op}` });
      }
    }
    return armError(400, 'Unhandled', `fake ARM does not implement ${method} ${path}`);
  }

  function logAnalytics(method: string, url: URL, body: Json | undefined, init?: RequestInit): Response {
    const m = /^\/v1\/workspaces\/([^/]+)\/query$/.exec(url.pathname);
    if (method !== 'POST' || !m) return armError(400, 'Unhandled', 'fake Log Analytics');
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const claims = JSON.parse(
      Buffer.from(auth.replace('Bearer ', '').split('.')[1]!, 'base64url').toString(),
    ) as { appid: string; aud: string };
    if (claims.aud !== 'https://api.loganalytics.io/.default')
      return armError(401, 'InvalidTokenError', 'wrong audience');
    const ws = [...workspaces.values()].find((w) => (w.properties as Json).customerId === m[1]);
    if (!ws) return armError(404, 'WorkspaceNotFoundError', 'Workspace not found.');
    const reader = assignments.some(
      (a) =>
        String(a.properties.scope).toLowerCase() === String(ws.id).toLowerCase() &&
        a.properties.principalId === automationSp.id &&
        claims.appid === opts.automation.clientId,
    );
    if (!reader)
      return armError(
        403,
        'InsufficientAccessError',
        'The provided credentials have insufficient access to perform the requested operation',
      );
    if (laForbidden > 0) {
      laForbidden--;
      return armError(
        403,
        'InsufficientAccessError',
        'The provided credentials have insufficient access to perform the requested operation',
      );
    }
    const query = String(body!.query);
    laQueries.push(query);
    if (/^print ok = 1$/.test(query))
      return json(200, {
        tables: [{ name: 'PrimaryResult', columns: [{ name: 'ok', type: 'long' }], rows: [[1]] }],
      });
    if (/^AzureActivity/.test(query)) {
      if (opts.activityRows === null)
        return armError(400, 'BadArgumentError', "'AzureActivity' could not be resolved to a table");
      return json(200, {
        tables: [
          {
            name: 'PrimaryResult',
            columns: [{ name: 'rows', type: 'long' }],
            rows: [[opts.activityRows ?? 0]],
          },
        ],
      });
    }
    return armError(400, 'BadArgumentError', 'unexpected query');
  }

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.host}${decodeURIComponent(url.pathname)}`);
    const body =
      typeof init?.body === 'string' && init.body.startsWith('{')
        ? (JSON.parse(init.body) as Json)
        : undefined;
    if (url.host === 'login.microsoftonline.com') return token(new URLSearchParams(String(init?.body)));
    if (url.host === 'graph.microsoft.com') return graph(method, url);
    if (url.host === 'management.azure.com') return arm(method, url, body);
    if (url.host === 'api.loganalytics.io') return logAnalytics(method, url, body, init);
    throw new Error(`fake azure: unexpected host ${url.host}`);
  };

  return {
    fetch: fetchImpl as typeof fetch,
    sub,
    automationSp,
    tester,
    resourceGroups,
    workspaces,
    diagnostics,
    assignments,
    calls,
    laQueries,
  };
}
