/**
 * A stand-in HashiCorp Vault for tests (no Vault instance exists yet): the endpoints AdminForge's Vault client uses —
 * Kubernetes and AppRole login, token lookup and renewal, KV version 2 reads — with token TTLs, revocation, secret
 * versions and outages. Answers through a `fetch`-shaped function (VaultClientOptions.fetch); records every call.
 */
export interface FakeVaultOptions {
  role?: string;
  jwt?: string;
  roleId?: string;
  secretId?: string;
  staticToken?: string;
  namespace?: string;
  ttlSeconds?: number;
  /** Whether login tokens can be renewed (default true): false makes AdminForge log in again near the lease's end. */
  renewable?: boolean;
  now?: () => number;
}

export function fakeVault(o: FakeVaultOptions = {}) {
  const now = o.now ?? Date.now;
  const tokens = new Map<string, number>(); // token → expiry (ms)
  const secrets = new Map<string, { data: Record<string, string>; version: number }>();
  const calls: Array<{
    method: string;
    path: string;
    token: string | null;
    namespace: string | null;
    redirect?: string;
  }> = [];
  const denied = new Set<string>(); // paths the policy doesn't grant
  const foreign404 = new Set<string>(); // paths something in front of Vault answers 404 for
  let down = false;
  let issued = 0;
  const ttl = o.ttlSeconds ?? 3600;
  const issue = () => {
    const t = `hvs.fake-${++issued}`;
    tokens.set(t, now() + ttl * 1000);
    return t;
  };
  if (o.staticToken) tokens.set(o.staticToken, now() + ttl * 1000);
  const reply = (status: number, body: unknown = {}) => ({
    status,
    ok: status < 300,
    json: async () => body,
  });
  const valid = (t: string | null) => !!t && (tokens.get(t) ?? 0) > now();

  async function fetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; redirect?: string },
  ) {
    if (down) throw new Error('connect ECONNREFUSED');
    const path = decodeURIComponent(new URL(url).pathname.replace(/^\/v1\//, ''));
    const token = init.headers['x-vault-token'] ?? null;
    const namespace = init.headers['x-vault-namespace'] ?? null;
    calls.push({ method: init.method, path, token, namespace, redirect: init.redirect });
    if (foreign404.has(path)) return reply(404, '<html>Not Found</html>');
    if (o.namespace && namespace !== o.namespace) return reply(403, { errors: ['permission denied'] });
    const body = init.body ? (JSON.parse(init.body) as Record<string, string>) : {};
    if (init.method === 'POST' && path === 'auth/kubernetes/login')
      return body.role === (o.role ?? 'adminforge') && body.jwt === (o.jwt ?? 'k8s-jwt')
        ? reply(200, { auth: { client_token: issue(), lease_duration: ttl, renewable: o.renewable ?? true } })
        : reply(403, { errors: ['permission denied'] });
    if (init.method === 'POST' && path === 'auth/approle/login')
      return body.role_id === (o.roleId ?? 'role-id') && body.secret_id === (o.secretId ?? 'secret-id')
        ? reply(200, { auth: { client_token: issue(), lease_duration: ttl, renewable: o.renewable ?? true } })
        : reply(403, { errors: ['invalid role or secret ID'] });
    if (!valid(token)) return reply(403, { errors: ['permission denied'] });
    if (init.method === 'GET' && path === 'auth/token/lookup-self')
      return reply(200, { data: { ttl, renewable: true } });
    if (init.method === 'POST' && path === 'auth/token/revoke-self') {
      tokens.delete(token!);
      return reply(204);
    }
    if (init.method === 'POST' && path === 'auth/token/renew-self') {
      tokens.set(token!, now() + ttl * 1000);
      return reply(200, { auth: { client_token: token, lease_duration: ttl, renewable: true } });
    }
    const m = /^([^/]+)\/data\/(.+)$/.exec(path);
    if (init.method === 'GET' && m) {
      if (denied.has(path)) return reply(403, { errors: ['permission denied'] });
      const s = secrets.get(`${m[1]}/${m[2]}`);
      return s
        ? reply(200, { data: { data: s.data, metadata: { version: s.version } } })
        : reply(404, { errors: [] });
    }
    return reply(404, { errors: [] });
  }

  return {
    fetch,
    calls,
    /** `vault kv put <mount>/<path> k=v …`: a new version of the secret. */
    put(mountAndPath: string, data: Record<string, string>) {
      const prev = secrets.get(mountAndPath);
      secrets.set(mountAndPath, { data, version: (prev?.version ?? 0) + 1 });
    },
    remove(mountAndPath: string) {
      secrets.delete(mountAndPath);
    },
    /** The policy stops granting a secret path (`<mount>/data/<path>`): reads answer 403, the token stays valid. */
    deny(dataPath: string) {
      denied.add(dataPath);
    },
    /** Something in front of Vault answers 404 for this path (not KV v2's own `{"errors":[]}`). */
    foreign404(dataPath: string) {
      foreign404.add(dataPath);
    },
    /** Tokens Vault still accepts. */
    liveTokens: () => [...tokens.keys()].filter((t) => valid(t)),
    /** Revokes every token issued so far. */
    revokeAll() {
      tokens.clear();
    },
    setDown(v: boolean) {
      down = v;
    },
  };
}
