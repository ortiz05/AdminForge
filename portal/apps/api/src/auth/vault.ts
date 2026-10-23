import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Config } from '../config';

/**
 * App-only credentials from HashiCorp Vault (ADR-018): the automation identity's and each named app identity's client
 * secret or certificate, read from a KV version 2 engine at `<kv mount>/<path>/identities/<name>` and kept in memory
 * only. Off unless AF_VAULT_ADDR is set. Values never reach a log line, an error, the audit log or a run output: errors
 * name the path and the HTTP status, never what was read.
 */

/** Where the pod's projected token for Vault is mounted (audience `vault`; portal/deploy/kubernetes/README.md). */
export const VAULT_TOKEN_FILE = '/var/run/secrets/vault/token';
/** The pod's Kubernetes API token: never the token for Vault (the pod mounts none; config.ts refuses it in production). */
export const KUBERNETES_API_TOKEN_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/token';

/**
 * Problem with a Vault mount or path, or undefined: segments of letters, digits, `.`, `_` and `-` separated by `/`,
 * none of them `.` or `..` (URL normalisation would resolve those, e.g. to `/v1/sys/…`).
 */
export function vaultPathProblem(path: string): string | undefined {
  const segments = path.split('/');
  return segments.every((s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..')
    ? undefined
    : 'must be names of letters, digits, dots, dashes and underscores separated by /, none of them . or ..';
}

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
    k8sTokenFile: cfg.AF_VAULT_K8S_TOKEN_FILE ?? VAULT_TOKEN_FILE,
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

/**
 * One identity's credential as Vault holds it. `version` is the KV secret's version; `fingerprint` changes whenever the
 * credential does (also when a deleted secret is written again at version 1) — compared, never logged.
 */
export interface VaultCredential {
  clientId?: string;
  clientSecret?: string;
  certificatePem?: string;
  version: number;
  fingerprint: string;
}

/**
 * A Vault call that failed: what was asked and the status, never a value. `scope` says whether it concerns one path
 * (that secret: the others can still be read) or Vault itself (login, network, a redirect, a server error).
 */
export class VaultError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly scope: 'path' | 'vault' = 'vault',
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; redirect: 'manual' },
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
/** Reads a reply's body to the end (so its connection is released) and ignores it. */
const drain = (res: { json(): Promise<unknown> }) =>
  res.json().then(
    () => undefined,
    () => undefined,
  );
const segments = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const fingerprint = (c: Record<string, string | undefined>) =>
  createHash('sha256')
    .update([c.clientId ?? '', c.clientSecret ?? '', c.certificatePem ?? ''].join('\0'))
    .digest('hex');

/** Logs in with the configured method, renews its token before it expires, and reads KV v2 secrets. */
export class VaultClient {
  #token: string | null = null;
  #tokenExpiresAt = 0;
  #tokenTtlMs = 0;
  #renewable = false;
  readonly #fetch: Fetch;
  readonly #readFile: (path: string) => string;
  readonly #now: () => number;

  constructor(
    private readonly s: VaultSettings,
    o: VaultClientOptions = {},
  ) {
    this.#readFile = o.readFile ?? ((p) => readFileSync(p, 'utf8'));
    this.#now = o.now ?? Date.now;
    if (o.fetch) this.#fetch = o.fetch;
    else {
      const dispatcher = s.caFile ? new Agent({ connect: { ca: this.#readFile(s.caFile) } }) : undefined;
      this.#fetch = (url, init) =>
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

  /**
   * One request to Vault. Redirects are never followed: fetch would send the token (and a login's JWT or secret id) on
   * to wherever Vault points — another host, or plain http — so a redirect is an error that names its status.
   */
  private async call(method: string, path: string, body?: unknown, token?: string) {
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.#fetch(`${this.s.addr}/v1/${path}`, {
        method,
        headers: this.headers(token),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
      });
    } catch {
      // Network, TLS or timeout: the address is configuration, the cause stays out of the message.
      throw new VaultError(`Vault at AF_VAULT_ADDR could not be reached (${method} /v1/${path}).`, null);
    }
    if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
      await drain(res);
      throw new VaultError(
        `Vault at AF_VAULT_ADDR answered ${method} /v1/${path} with a redirect (HTTP ${res.status}), which AdminForge doesn't follow: point AF_VAULT_ADDR at the active node, or turn on request forwarding.`,
        res.status,
      );
    }
    return res;
  }

  private readSecretFile(file: string, key: string): string {
    try {
      const v = this.#readFile(file).trim();
      if (!v) throw new Error('empty');
      return v;
    } catch {
      throw new VaultError(`${key} cannot be read, or is empty.`, null);
    }
  }

  /** A token: from the token file, or by logging in (Kubernetes service-account JWT or AppRole). */
  private async login(): Promise<void> {
    if (this.s.auth === 'token') {
      const token = this.readSecretFile(this.s.tokenFile!, 'AF_VAULT_TOKEN_FILE');
      const res = await this.call('GET', 'auth/token/lookup-self', undefined, token);
      if (!res.ok) {
        await drain(res);
        throw new VaultError(
          `Vault refused the token in AF_VAULT_TOKEN_FILE (HTTP ${res.status}).`,
          res.status,
        );
      }
      const data = rec(rec(await res.json()).data);
      this.#token = token;
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
    if (!res.ok) {
      await drain(res);
      throw new VaultError(
        `Vault refused the ${this.s.auth === 'kubernetes' ? 'Kubernetes' : 'AppRole'} login at auth/${this.s.authMount} (HTTP ${res.status}).`,
        res.status,
      );
    }
    const auth = rec(rec(await res.json()).auth);
    if (typeof auth.client_token !== 'string' || !auth.client_token)
      throw new VaultError(`Vault's login at auth/${this.s.authMount} returned no token.`, res.status);
    this.#token = auth.client_token;
    this.setLease(Number(auth.lease_duration ?? 0), auth.renewable === true);
  }

  private setLease(ttlSeconds: number, renewable: boolean) {
    this.#tokenTtlMs = ttlSeconds > 0 ? ttlSeconds * 1000 : 0;
    this.#tokenExpiresAt = ttlSeconds > 0 ? this.#now() + this.#tokenTtlMs : Number.POSITIVE_INFINITY;
    this.#renewable = renewable;
  }

  /** Best effort: a token AdminForge logged in for and no longer uses is revoked, so leases don't pile up. */
  private async revoke(token: string): Promise<void> {
    if (this.s.auth === 'token') return; // the token file's token isn't ours to revoke
    try {
      await drain(await this.call('POST', 'auth/token/revoke-self', {}, token));
    } catch {
      // It expires on its own.
    }
  }

  /** A token valid for a while: renewed (or a new login) once two thirds of its lease have passed. */
  private async validToken(): Promise<string> {
    const left = this.#tokenExpiresAt - this.#now();
    if (this.#token && (left === Number.POSITIVE_INFINITY || left > this.#tokenTtlMs / 3)) return this.#token;
    const old = this.#token;
    if (old && this.#renewable && left > 0) {
      const res = await this.call('POST', 'auth/token/renew-self', {}, old);
      if (res.ok) {
        const auth = rec(rec(await res.json()).auth);
        this.setLease(Number(auth.lease_duration ?? 0), auth.renewable === true);
        return old;
      }
      await drain(res);
    }
    await this.login();
    if (old && old !== this.#token && left > 0) void this.revoke(old);
    return this.#token!;
  }

  /** Whether Vault still accepts this token (a 403 can mean a revoked token or a path the policy doesn't grant). */
  private async tokenAccepted(token: string): Promise<boolean> {
    const res = await this.call('GET', 'auth/token/lookup-self', undefined, token);
    await drain(res);
    return res.ok;
  }

  /** The KV v2 secret `<path>/identities/<name>`; null when Vault says it doesn't exist. */
  async readIdentity(name: string): Promise<VaultCredential | null> {
    const secretPath = `${segments(this.s.kvMount)}/data/${segments(this.s.path)}/identities/${encodeURIComponent(name)}`;
    let loggedInAgain = false;
    for (;;) {
      const token = await this.validToken();
      const res = await this.call('GET', secretPath, undefined, token);
      if (res.status === 404) {
        // KV v2's own "no such secret" is {"errors":[]}; any other 404 (a proxy's, a wrong mount) isn't a deletion.
        const errors = rec(await res.json().catch(() => null)).errors;
        if (Array.isArray(errors) && errors.length === 0) return null;
        throw new VaultError(
          `Vault answered ${secretPath} with HTTP 404 but not as a missing secret (the wrong AF_VAULT_KV_MOUNT, or something in front of Vault?).`,
          404,
          'path',
        );
      }
      if (res.status === 403) {
        await drain(res);
        // A revoked or expired token: one new login. A token Vault still accepts: its policy doesn't grant this path,
        // which another login wouldn't change.
        if (!loggedInAgain && !(await this.tokenAccepted(token))) {
          loggedInAgain = true;
          this.#token = null;
          continue;
        }
        throw new VaultError(
          `Vault refused to read ${secretPath} (HTTP 403): its policy for AdminForge doesn't grant this path.`,
          403,
          'path',
        );
      }
      if (!res.ok) {
        await drain(res);
        throw new VaultError(
          `Vault refused to read ${secretPath} (HTTP ${res.status}).`,
          res.status,
          res.status >= 500 ? 'vault' : 'path',
        );
      }
      const outer = rec(rec(await res.json()).data);
      const data = rec(outer.data);
      const str = (k: string) => (typeof data[k] === 'string' && data[k] ? (data[k] as string) : undefined);
      const fields = {
        clientId: str('client_id'),
        clientSecret: str('client_secret'),
        certificatePem: str('certificate_pem'),
      };
      return {
        ...(fields.clientId ? { clientId: fields.clientId } : {}),
        ...(fields.clientSecret ? { clientSecret: fields.clientSecret } : {}),
        ...(fields.certificatePem ? { certificatePem: fields.certificatePem } : {}),
        version: Number(rec(outer.metadata).version ?? 0),
        fingerprint: fingerprint(fields),
      };
    }
  }
}

/**
 * What the Vault probe shows (no values). Per identity: `loaded`; `stale` (loaded earlier, the last read failed — the
 * credential stays in use); `missing` (Vault has no secret at its path); `unavailable` (never loaded, the read
 * failed); `not_read` (no refresh yet).
 */
export type VaultIdentityState = 'loaded' | 'stale' | 'missing' | 'unavailable' | 'not_read';
export interface VaultStatus {
  /** When the last refresh finished, whether or not every read worked. */
  lastRefreshAt: string | null;
  identities: Record<string, VaultIdentityState>;
  /** Why an identity's last read failed (path and status): for the log and the probe's Operator-only details. */
  errors: Record<string, string>;
}

/** How long after a refresh an identity that has nothing loaded waits before a run asks Vault again. */
const RETRY_MS = 30_000;

/**
 * The credentials of every app-only identity, from Vault: read at start, every `refreshSeconds`, and at once (at most
 * every 30 s per identity) when Microsoft rejects one. Each identity is read on its own: one Vault refuses leaves the
 * others alone; a failure of Vault itself (login, network) stops the round. A failed read keeps the last good credential.
 */
export class VaultCredentials {
  readonly #cache = new Map<string, VaultCredential>();
  readonly #missing = new Set<string>();
  readonly #errors = new Map<string, string>();
  #lastRefreshAt: number | null = null;
  #inFlight: Promise<void> | null = null;
  readonly #lastForced = new Map<string, number>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: Pick<VaultClient, 'readIdentity'>,
    readonly names: readonly string[],
    private readonly o: {
      refreshSeconds: number;
      now?: () => number;
      log?: { warn(obj: object, msg: string): void; info?(obj: object, msg: string): void };
      path?: string;
    },
  ) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private async readOne(name: string): Promise<void> {
    const c = await this.client.readIdentity(name);
    this.#errors.delete(name);
    if (c && (c.clientSecret || c.certificatePem)) {
      const before = this.#cache.get(name);
      if (before && before.fingerprint !== c.fingerprint)
        this.o.log?.info?.({ identity: name, version: c.version }, 'vault credential changed');
      this.#cache.set(name, c);
      this.#missing.delete(name);
    } else {
      this.#cache.delete(name);
      this.#missing.add(name);
    }
  }

  /** Reads every identity's secret; one at a time, so a refresh is a handful of small requests. */
  refresh(): Promise<void> {
    this.#inFlight ??= (async () => {
      try {
        let vaultDown: string | undefined;
        for (const name of this.names) {
          if (vaultDown) {
            this.#errors.set(name, vaultDown);
            continue;
          }
          try {
            await this.readOne(name);
          } catch (err) {
            const message = err instanceof VaultError ? err.message : 'Vault could not be read.';
            this.#errors.set(name, message);
            if (!(err instanceof VaultError && err.scope === 'path')) vaultDown = message;
          }
        }
        if (this.#errors.size)
          this.o.log?.warn(
            { vault: this.o.path ?? 'AF_VAULT_PATH', errors: Object.fromEntries(this.#errors) },
            'vault refresh failed',
          );
      } finally {
        this.#lastRefreshAt = this.now();
        this.#inFlight = null;
      }
    })();
    return this.#inFlight;
  }

  /**
   * The identity's credential. Nothing loaded yet: waits for the refresh under way, or reads Vault — unless a refresh
   * finished less than 30 s ago, so runs of an identity Vault can't give don't each start one.
   */
  async ensure(name: string): Promise<VaultCredential | null> {
    if (this.#inFlight) await this.#inFlight;
    else if (
      !this.#cache.has(name) &&
      !this.#missing.has(name) &&
      (this.#lastRefreshAt === null || this.now() - this.#lastRefreshAt >= RETRY_MS)
    )
      await this.refresh();
    return this.#cache.get(name) ?? null;
  }

  current(name: string): VaultCredential | undefined {
    return this.#cache.get(name);
  }

  /** Microsoft rejected the credential: read again now (rotation), at most every 30 s per identity. */
  async refreshNow(name: string): Promise<VaultCredential | null> {
    const last = this.#lastForced.get(name) ?? 0;
    if (this.now() - last >= RETRY_MS) {
      this.#lastForced.set(name, this.now());
      await this.refresh();
    }
    return this.#cache.get(name) ?? null;
  }

  start(): void {
    void this.refresh();
    this.#timer ??= setInterval(() => void this.refresh(), this.o.refreshSeconds * 1000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  status(): VaultStatus {
    const state = (n: string): VaultIdentityState => {
      if (this.#cache.has(n)) return this.#errors.has(n) ? 'stale' : 'loaded';
      if (this.#missing.has(n)) return 'missing';
      return this.#errors.has(n) ? 'unavailable' : 'not_read';
    };
    return {
      lastRefreshAt: this.#lastRefreshAt === null ? null : new Date(this.#lastRefreshAt).toISOString(),
      identities: Object.fromEntries(this.names.map((n) => [n, state(n)])),
      errors: Object.fromEntries(this.#errors),
    };
  }
}
