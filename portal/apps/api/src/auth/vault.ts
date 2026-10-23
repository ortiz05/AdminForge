import { readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Config } from '../config';

/**
 * App-only credentials from HashiCorp Vault (ADR-018): the automation identity's and each named app identity's client
 * secret or certificate, read from a KV version 2 engine at `<kv mount>/<path>/identities/<name>` and kept in memory
 * only. Off unless AF_VAULT_ADDR is set. Values never reach a log line, an error, the audit log or a run output: errors
 * name the path and the HTTP status, never what was read.
 */

export interface VaultSettings {
  addr: string;
  auth: 'kubernetes' | 'approle' | 'token';
  authMount: string;
  role?: string;
  k8sTokenFile: string;
  roleId?: string;
  secretIdFile?: string;
  tokenFile?: string;
  namespace?: string;
  caFile?: string;
  kvMount: string;
  path: string;
  refreshSeconds: number;
}

/** The Vault settings, or null when Vault is off (no AF_VAULT_ADDR). */
export function vaultSettings(
  cfg: Pick<Config, 'AF_ENV_LABEL'> & Partial<Pick<Config, Extract<keyof Config, `AF_VAULT_${string}`>>>,
): VaultSettings | null {
  if (!cfg.AF_VAULT_ADDR) return null;
  const auth = cfg.AF_VAULT_AUTH ?? 'kubernetes';
  return {
    addr: cfg.AF_VAULT_ADDR.replace(/\/+$/, ''),
    auth,
    authMount: cfg.AF_VAULT_AUTH_MOUNT ?? (auth === 'approle' ? 'approle' : 'kubernetes'),
    ...(cfg.AF_VAULT_ROLE ? { role: cfg.AF_VAULT_ROLE } : {}),
    k8sTokenFile: cfg.AF_VAULT_K8S_TOKEN_FILE ?? '/var/run/secrets/kubernetes.io/serviceaccount/token',
    ...(cfg.AF_VAULT_ROLE_ID ? { roleId: cfg.AF_VAULT_ROLE_ID } : {}),
    ...(cfg.AF_VAULT_SECRET_ID_FILE ? { secretIdFile: cfg.AF_VAULT_SECRET_ID_FILE } : {}),
    ...(cfg.AF_VAULT_TOKEN_FILE ? { tokenFile: cfg.AF_VAULT_TOKEN_FILE } : {}),
    ...(cfg.AF_VAULT_NAMESPACE ? { namespace: cfg.AF_VAULT_NAMESPACE } : {}),
    ...(cfg.AF_VAULT_CA_FILE ? { caFile: cfg.AF_VAULT_CA_FILE } : {}),
    kvMount: cfg.AF_VAULT_KV_MOUNT ?? 'secret',
    path: cfg.AF_VAULT_PATH ?? `adminforge/${cfg.AF_ENV_LABEL ?? 'dev'}`,
    refreshSeconds: cfg.AF_VAULT_REFRESH_SECONDS ?? 300,
  };
}

/** One identity's credential as Vault holds it; `version` is the KV secret's version (rotation). */
export interface VaultCredential {
  clientId?: string;
  clientSecret?: string;
  certificatePem?: string;
  version: number;
}

/** A Vault call that failed: what was asked and the status, never a value. */
export class VaultError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}>;

export interface VaultClientOptions {
  /** Tests inject a fake; default undici's fetch (with AF_VAULT_CA_FILE as the trust store). */
  fetch?: Fetch;
  readFile?: (path: string) => string;
  now?: () => number;
}

const TIMEOUT_MS = 10_000;
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** Logs in with the configured method, renews its token before it expires, and reads KV v2 secrets. */
export class VaultClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private tokenTtlMs = 0;
  private renewable = false;
  private readonly doFetch: Fetch;
  private readonly readFile: (path: string) => string;
  private readonly now: () => number;

  constructor(
    private readonly s: VaultSettings,
    o: VaultClientOptions = {},
  ) {
    this.readFile = o.readFile ?? ((p) => readFileSync(p, 'utf8'));
    this.now = o.now ?? Date.now;
    if (o.fetch) this.doFetch = o.fetch;
    else {
      const dispatcher = s.caFile ? new Agent({ connect: { ca: this.readFile(s.caFile) } }) : undefined;
      this.doFetch = (url, init) =>
        undiciFetch(url, {
          ...init,
          signal: AbortSignal.timeout(TIMEOUT_MS),
          ...(dispatcher ? { dispatcher } : {}),
        });
    }
  }

  private headers(token?: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.s.namespace ? { 'x-vault-namespace': this.s.namespace } : {}),
      ...(token ? { 'x-vault-token': token } : {}),
    };
  }

  private async call(method: string, path: string, body?: unknown, token?: string) {
    try {
      return await this.doFetch(`${this.s.addr}/v1/${path}`, {
        method,
        headers: this.headers(token),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // Network, TLS or timeout: the address is configuration, the cause stays out of the message.
      throw new VaultError(`Vault at AF_VAULT_ADDR could not be reached (${method} /v1/${path}).`, null);
    }
  }

  private readSecretFile(file: string, key: string): string {
    try {
      const v = this.readFile(file).trim();
      if (!v) throw new Error('empty');
      return v;
    } catch {
      throw new VaultError(`${key} cannot be read, or is empty.`, null);
    }
  }

  /** A token: from the token file, or by logging in (Kubernetes service-account JWT or AppRole). */
  private async login(): Promise<void> {
    if (this.s.auth === 'token') {
      this.token = this.readSecretFile(this.s.tokenFile!, 'AF_VAULT_TOKEN_FILE');
      const res = await this.call('GET', 'auth/token/lookup-self', undefined, this.token);
      if (!res.ok)
        throw new VaultError(
          `Vault refused the token in AF_VAULT_TOKEN_FILE (HTTP ${res.status}).`,
          res.status,
        );
      const data = rec(rec(await res.json()).data);
      this.setLease(Number(data.ttl ?? 0), data.renewable === true);
      return;
    }
    const body =
      this.s.auth === 'kubernetes'
        ? { role: this.s.role, jwt: this.readSecretFile(this.s.k8sTokenFile, 'AF_VAULT_K8S_TOKEN_FILE') }
        : {
            role_id: this.s.roleId,
            secret_id: this.readSecretFile(this.s.secretIdFile!, 'AF_VAULT_SECRET_ID_FILE'),
          };
    const res = await this.call('POST', `auth/${this.s.authMount}/login`, body);
    if (!res.ok)
      throw new VaultError(
        `Vault refused the ${this.s.auth === 'kubernetes' ? 'Kubernetes' : 'AppRole'} login at auth/${this.s.authMount} (HTTP ${res.status}).`,
        res.status,
      );
    const auth = rec(rec(await res.json()).auth);
    if (typeof auth.client_token !== 'string' || !auth.client_token)
      throw new VaultError(`Vault's login at auth/${this.s.authMount} returned no token.`, res.status);
    this.token = auth.client_token;
    this.setLease(Number(auth.lease_duration ?? 0), auth.renewable === true);
  }

  private setLease(ttlSeconds: number, renewable: boolean) {
    this.tokenTtlMs = ttlSeconds > 0 ? ttlSeconds * 1000 : 0;
    this.tokenExpiresAt = ttlSeconds > 0 ? this.now() + this.tokenTtlMs : Number.POSITIVE_INFINITY;
    this.renewable = renewable;
  }

  /** A token valid for a while: renewed (or a new login) once two thirds of its lease have passed. */
  private async validToken(): Promise<string> {
    const left = this.tokenExpiresAt - this.now();
    if (this.token && (left === Number.POSITIVE_INFINITY || left > this.tokenTtlMs / 3)) return this.token;
    if (this.token && this.renewable && left > 0) {
      const res = await this.call('POST', 'auth/token/renew-self', {}, this.token);
      if (res.ok) {
        const auth = rec(rec(await res.json()).auth);
        this.setLease(Number(auth.lease_duration ?? 0), auth.renewable === true);
        return this.token;
      }
    }
    await this.login();
    return this.token!;
  }

  /** The KV v2 secret `<path>/identities/<name>`; null when it doesn't exist. */
  async readIdentity(name: string): Promise<VaultCredential | null> {
    const secretPath = `${this.s.kvMount}/data/${this.s.path}/identities/${name}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.call('GET', secretPath, undefined, await this.validToken());
      if (res.status === 404) return null;
      // A revoked or expired token: log in again once.
      if (res.status === 403 && attempt === 0) {
        this.token = null;
        continue;
      }
      if (!res.ok)
        throw new VaultError(`Vault refused to read ${secretPath} (HTTP ${res.status}).`, res.status);
      const outer = rec(rec(await res.json()).data);
      const data = rec(outer.data);
      const str = (k: string) => (typeof data[k] === 'string' && data[k] ? (data[k] as string) : undefined);
      const clientId = str('client_id');
      const clientSecret = str('client_secret');
      const certificatePem = str('certificate_pem');
      return {
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
        ...(certificatePem ? { certificatePem } : {}),
        version: Number(rec(outer.metadata).version ?? 0),
      };
    }
    throw new VaultError(`Vault refused to read ${secretPath} (HTTP 403).`, 403);
  }
}

/** What the Vault probe and `provision status` show: no values. */
export interface VaultStatus {
  reachable: boolean;
  lastRefreshAt: string | null;
  /** Each identity: its credential loaded, missing at its path, or not read yet. */
  identities: Record<string, 'loaded' | 'missing' | 'not_read'>;
  /** The last refresh's failure (path and status), when it failed. */
  error?: string;
}

/**
 * The credentials of every app-only identity, from Vault: read at start, every `refreshSeconds`, and at once (at most
 * every 30 s per identity) when Microsoft rejects one. A failed refresh keeps the last good credentials.
 */
export class VaultCredentials {
  private readonly cache = new Map<string, VaultCredential>();
  private readonly missing = new Set<string>();
  private lastRefreshAt: number | null = null;
  private lastError: string | undefined;
  private inFlight: Promise<void> | null = null;
  private readonly lastForced = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: Pick<VaultClient, 'readIdentity'>,
    readonly names: readonly string[],
    private readonly o: {
      refreshSeconds: number;
      now?: () => number;
      log?: { warn(obj: object, msg: string): void };
      path?: string;
    },
  ) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Reads every identity's secret; one at a time, so a refresh is a handful of small requests. */
  refresh(): Promise<void> {
    this.inFlight ??= (async () => {
      try {
        for (const name of this.names) {
          const c = await this.client.readIdentity(name);
          if (c && (c.clientSecret || c.certificatePem)) {
            this.cache.set(name, c);
            this.missing.delete(name);
          } else {
            this.cache.delete(name);
            this.missing.add(name);
          }
        }
        this.lastRefreshAt = this.now();
        this.lastError = undefined;
      } catch (err) {
        this.lastError = err instanceof VaultError ? err.message : 'Vault could not be read.';
        this.o.log?.warn(
          { vault: this.o.path ?? 'AF_VAULT_PATH', error: this.lastError },
          'vault refresh failed',
        );
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** The identity's credential, reading Vault first if nothing was read yet. */
  async ensure(name: string): Promise<VaultCredential | null> {
    if (!this.cache.has(name) && !this.missing.has(name)) await this.refresh();
    return this.cache.get(name) ?? null;
  }

  current(name: string): VaultCredential | undefined {
    return this.cache.get(name);
  }

  /** Microsoft rejected the credential: read again now (rotation), at most every 30 s per identity. */
  async refreshNow(name: string): Promise<VaultCredential | null> {
    const last = this.lastForced.get(name) ?? 0;
    if (this.now() - last >= 30_000) {
      this.lastForced.set(name, this.now());
      await this.refresh();
    }
    return this.cache.get(name) ?? null;
  }

  start(): void {
    void this.refresh();
    this.timer ??= setInterval(() => void this.refresh(), this.o.refreshSeconds * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): VaultStatus {
    return {
      reachable: this.lastRefreshAt !== null && this.lastError === undefined,
      lastRefreshAt: this.lastRefreshAt === null ? null : new Date(this.lastRefreshAt).toISOString(),
      identities: Object.fromEntries(
        this.names.map((n) => [
          n,
          this.cache.has(n) ? 'loaded' : this.missing.has(n) ? 'missing' : 'not_read',
        ]),
      ),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }
}
