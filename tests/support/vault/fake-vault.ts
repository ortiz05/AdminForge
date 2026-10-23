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
  now?: () => number;
}

export function fakeVault(o: FakeVaultOptions = {}) {
  const now = o.now ?? Date.now;
  const tokens = new Map<string, number>(); // token → expiry (ms)
  const secrets = new Map<string, { data: Record<string, string>; version: number }>();
  const calls: Array<{ method: string; path: string; token: string | null; namespace: string | null }> = [];
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
    init: { method: string; headers: Record<string, string>; body?: string },
  ) {
    if (down) throw new Error('connect ECONNREFUSED');
    const path = new URL(url).pathname.replace(/^\/v1\//, '');
    const token = init.headers['x-vault-token'] ?? null;
    const namespace = init.headers['x-vault-namespace'] ?? null;
    calls.push({ method: init.method, path, token, namespace });
    if (o.namespace && namespace !== o.namespace) return reply(403, { errors: ['permission denied'] });
    const body = init.body ? (JSON.parse(init.body) as Record<string, string>) : {};
    if (init.method === 'POST' && path === 'auth/kubernetes/login')
      return body.role === (o.role ?? 'adminforge') && body.jwt === (o.jwt ?? 'k8s-jwt')
        ? reply(200, { auth: { client_token: issue(), lease_duration: ttl, renewable: true } })
        : reply(403, { errors: ['permission denied'] });
    if (init.method === 'POST' && path === 'auth/approle/login')
      return body.role_id === (o.roleId ?? 'role-id') && body.secret_id === (o.secretId ?? 'secret-id')
        ? reply(200, { auth: { client_token: issue(), lease_duration: ttl, renewable: true } })
        : reply(403, { errors: ['invalid role or secret ID'] });
    if (!valid(token)) return reply(403, { errors: ['permission denied'] });
    if (init.method === 'GET' && path === 'auth/token/lookup-self')
      return reply(200, { data: { ttl, renewable: true } });
    if (init.method === 'POST' && path === 'auth/token/renew-self') {
      tokens.set(token!, now() + ttl * 1000);
      return reply(200, { auth: { client_token: token, lease_duration: ttl, renewable: true } });
    }
    const m = /^([^/]+)\/data\/(.+)$/.exec(path);
    if (init.method === 'GET' && m) {
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
    /** Revokes every token issued so far. */
    revokeAll() {
      tokens.clear();
    },
    setDown(v: boolean) {
      down = v;
    },
  };
}
