/**
 * Turns live API responses into synthetic fixtures for `adminforge fixtures record` (R2: nothing tenant-specific is
 * committed).
 *
 * Two passes over everything recorded in one run, so replacements are consistent across files:
 *  1. collect: GUIDs, e-mail addresses / UPNs, tenant domains, names (displayName, department, resource names…),
 *     IP addresses and paging tokens get synthetic stand-ins (`Example User 3`, `user3@example.com`,
 *     `5ca1ed00-0000-4000-8000-000000000007`, `192.0.2.4`, `page2`);
 *  2. apply: every string (bodies and URLs) is rewritten with those maps.
 * Finally `leaks` names any forbidden value (anything from the local env file) the output still contains, and the
 * command refuses to write that file. Microsoft's tenant-independent GUIDs (`keepGuids`) and synthetic values stay.
 * Pure (no I/O).
 */
import { GUID_PATTERN } from '../provision/ids';

const GUID_RE = new RegExp(`\\b${GUID_PATTERN}\\b`, 'gi');
/** Local parts may contain an apostrophe (o'brien@…) but never start with one (`'user@…'` inside OData literals). */
const EMAIL_RE =
  /(?<![A-Za-z0-9._%+#-])[A-Za-z0-9._%+#-][A-Za-z0-9._%+'#-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const TOKEN_PARAMS = /([?&](?:\$?skip[Tt]oken|skiptoken)=)([^&#]+)/g;

/** Microsoft-owned hosts stay as they are (service URLs in nextLinks, portal links). */
const MICROSOFT_DOMAIN =
  /(^|\.)(microsoft\.com|microsoftonline\.com|azure\.com|azure\.net|windows\.net|office\.com|office365\.com|outlook\.com|live\.com|microsoftazuread-sso\.com|cloud\.microsoft)$/i;
/** Example values already synthetic. */
const SYNTHETIC_DOMAIN = /(^|\.)(example\.(com|net|org)|example\d+\.com|exampleorg\d*\.onmicrosoft\.com)$/i;

/** Keys whose string values are names or other identifying free text. */
const NAME_KEYS = new Set([
  'displayName',
  'givenName',
  'surname',
  'mailNickname',
  'jobTitle',
  'department',
  'companyName',
  'officeLocation',
  'streetAddress',
  'city',
  'state',
  'postalCode',
  'country',
  'onPremisesSamAccountName',
  'onPremisesDistinguishedName',
  'onPremisesDomainName',
  'employeeId',
  'name',
  'resourceGroup',
  'computerName',
  'hostName',
  'deviceName',
  'managedDeviceOwnerType',
  'userDisplayName',
  'appDisplayName',
  'principalDisplayName',
  'resourceDisplayName',
  'createdBy',
  'description',
]);
const PHONE_KEYS = new Set(['mobilePhone', 'businessPhones', 'faxNumber', 'phoneNumber', 'phoneNumbers']);
/** Names that are generic product words, never tenant data. */
const KEEP_TEXT = new Set([
  'microsoft graph',
  'office 365 exchange online',
  'windows azure service management api',
  'enabled',
  'disabled',
  'member',
  'guest',
  'user',
  'unknown',
  'none',
]);
const KIND_OF: Record<string, string> = {
  users: 'User',
  user: 'User',
  groups: 'Group',
  group: 'Group',
  devices: 'Device',
  device: 'Device',
  manageddevices: 'Device',
  applications: 'App',
  application: 'App',
  serviceprincipals: 'App',
  serviceprincipal: 'App',
  organization: 'Org',
  sites: 'Site',
  site: 'Site',
  teams: 'Team',
};

export interface SanitizerOptions {
  /** Values that must never appear in output (env file values, tenant id, client ids …). Checked case-insensitively. */
  forbidden?: string[];
  /** Tenant domains known up front (AF_PRIMARY_DOMAIN); more are discovered from the data. The first maps to example.com. */
  domains?: string[];
  /** GUIDs that are tenant-independent Microsoft constants (resource app ids, role template ids) and stay as they are. */
  keepGuids?: string[];
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const pad = (n: number) => String(n).padStart(12, '0');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Sanitizer {
  private readonly guids = new Map<string, string>();
  private readonly domains = new Map<string, string>();
  private readonly emails = new Map<string, string>();
  private readonly texts = new Map<string, string>();
  private readonly ips = new Map<string, string>();
  private readonly tokens = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  private readonly keep: Set<string>;
  private readonly forbidden: string[];

  constructor(opts: SanitizerOptions = {}) {
    this.keep = new Set((opts.keepGuids ?? []).map((g) => g.toLowerCase()));
    this.keep.add('00000000-0000-0000-0000-000000000000');
    this.forbidden = (opts.forbidden ?? []).map((f) => f.trim()).filter((f) => f.length >= 6);
    for (const d of opts.domains ?? []) if (d) this.domain(d);
  }

  private next(kind: string): number {
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    return n;
  }

  guid(g: string): string {
    const key = g.toLowerCase();
    if (this.keep.has(key) || /^(5ca1ed00|00000000)-0000-4000-8000-/.test(key)) return g;
    let v = this.guids.get(key);
    if (!v) this.guids.set(key, (v = `5ca1ed00-0000-4000-8000-${pad(this.next('guid'))}`));
    return v;
  }

  domain(d: string): string {
    const key = d.toLowerCase();
    if (MICROSOFT_DOMAIN.test(key) || SYNTHETIC_DOMAIN.test(key)) return d;
    let v = this.domains.get(key);
    if (!v) {
      if (key.endsWith('.onmicrosoft.com')) {
        const n = this.next('tenant');
        v = n === 1 ? 'exampleorg.onmicrosoft.com' : `exampleorg${n}.onmicrosoft.com`;
        // The tenant name also appears in SharePoint hosts (contoso.sharepoint.com, contoso-my…, contoso-admin…).
        const tenant = key.slice(0, -'.onmicrosoft.com'.length);
        const synthetic = v.slice(0, -'.onmicrosoft.com'.length);
        for (const suffix of ['.sharepoint.com', '-my.sharepoint.com', '-admin.sharepoint.com'])
          this.domains.set(`${tenant}${suffix}`, `${synthetic}${suffix}`);
      } else {
        const n = this.next('domain');
        v = n === 1 ? 'example.com' : `example${n}.com`;
      }
      this.domains.set(key, v);
    }
    return v;
  }

  email(e: string): string {
    const key = e.toLowerCase();
    let v = this.emails.get(key);
    if (!v) {
      const at = key.lastIndexOf('@');
      const domain = this.domain(key.slice(at + 1));
      if (SYNTHETIC_DOMAIN.test(key.slice(at + 1))) return e;
      v = key.includes('#ext#')
        ? `guest${this.next('guest')}#EXT#@${domain}`
        : `user${this.next('user')}@${domain}`;
      this.emails.set(key, v);
    }
    return v;
  }

  private text(original: string, key: string, kind: string): void {
    const t = original.trim();
    if (
      !t ||
      KEEP_TEXT.has(t.toLowerCase()) ||
      this.texts.has(t) ||
      /^(Example|example-|rg-example-|user\d|guest\d)/.test(t) ||
      /^[\d\s.:/-]+$/.test(t)
    )
      return;
    let v: string;
    if (key === 'displayName' && kind === 'Org') v = 'Example Org';
    else if (key === 'resourceGroup') v = `rg-example-${this.next('rg')}`;
    else if (
      (key === 'name' || key === 'computerName' || key === 'hostName' || key === 'deviceName') &&
      !/\s/.test(t)
    )
      v = `example-${this.next('res')}`;
    else if (key === 'displayName') v = `Example ${kind} ${this.next(`dn:${kind}`)}`;
    else if (key === 'description') v = 'Example description';
    else
      v = `Example ${key
        .replace(/([A-Z])/g, ' $1')
        .toLowerCase()
        .trim()} ${this.next(key)}`;
    this.texts.set(t, v);
  }

  private ip(ip: string): string {
    if (/^(0\.0\.0\.0|127\.|192\.0\.2\.)/.test(ip)) return ip;
    let v = this.ips.get(ip);
    if (!v) this.ips.set(ip, (v = `192.0.2.${this.next('ip') % 254 || 254}`));
    return v;
  }

  private token(t: string): string {
    if (/^page\d+$/.test(t)) return t;
    let v = this.tokens.get(t);
    if (!v) this.tokens.set(t, (v = `page${this.next('token') + 1}`));
    return v;
  }

  /** Pass 1 over a string: register GUIDs, e-mails, IPs, paging tokens, URL hosts. */
  private scan(s: string): void {
    for (const m of s.matchAll(GUID_RE)) this.guid(m[0]);
    for (const m of s.matchAll(EMAIL_RE)) this.email(m[0]);
    for (const m of s.matchAll(IPV4_RE)) this.ip(m[0]);
    for (const m of s.matchAll(TOKEN_PARAMS)) this.token(decodeURIComponent(m[2]!));
  }

  /** Pass 1: everything identifying in a response body (`kind` from the request path when known). */
  collect(value: unknown, kind = 'Item', key = ''): void {
    if (typeof value === 'string') {
      this.scan(value);
      if (NAME_KEYS.has(key)) this.text(value, key, kind);
      if (key === '$skipToken' || key === 'skipToken') this.token(value);
      if (/^(https?:)?\/\//.test(value)) {
        try {
          this.domain(new URL(value).hostname);
        } catch {
          // not a URL
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) this.collect(v, kind, key);
      return;
    }
    if (!isPlain(value)) return;
    const odata =
      typeof value['@odata.type'] === 'string'
        ? KIND_OF[value['@odata.type'].replace(/^#microsoft\.graph\./, '').toLowerCase()]
        : undefined;
    const here = odata ?? kind;
    if (Array.isArray(value.verifiedDomains))
      for (const d of value.verifiedDomains as Array<{ name?: string }>) if (d?.name) this.domain(d.name);
    for (const [k, v] of Object.entries(value)) {
      if (PHONE_KEYS.has(k)) continue;
      this.collect(v, here, k);
    }
  }

  /** Pass 1 over a request URL (path segments and query values). */
  collectUrl(url: string): void {
    const u = new URL(url);
    for (const seg of u.pathname.split('/')) this.scan(safeDecode(seg));
    for (const [, v] of u.searchParams) this.scan(v);
    for (const m of url.matchAll(TOKEN_PARAMS)) this.token(decodeURIComponent(m[2]!));
  }

  /** Pass 2 over one string. */
  string(s: string): string {
    let out = s.replace(GUID_RE, (g) => this.guid(g));
    out = out.replace(EMAIL_RE, (e) => this.email(e));
    out = out.replace(
      TOKEN_PARAMS,
      (_m, p: string, t: string) => `${p}${encodeURIComponent(this.token(decodeURIComponent(t)))}`,
    );
    for (const [from, to] of [...this.domains].sort((a, b) => b[0].length - a[0].length))
      out = out.replace(new RegExp(`(?<![A-Za-z0-9-])${escapeRe(from)}(?![A-Za-z0-9-])`, 'gi'), to);
    for (const [from, to] of [...this.texts].sort((a, b) => b[0].length - a[0].length)) {
      if (from.length >= 4) out = out.split(from).join(to);
      else if (out === from) out = to;
    }
    out = out.replace(IPV4_RE, (ip) => this.ip(ip));
    return out;
  }

  /** Pass 2: a sanitized deep copy (phone numbers replaced, paging tokens remapped). */
  apply<T>(value: T, key = ''): T {
    if (typeof value === 'string') {
      if (PHONE_KEYS.has(key)) return '+1 555 0100' as T;
      if ((key === '$skipToken' || key === 'skipToken') && this.tokens.has(value))
        return this.tokens.get(value) as T;
      return this.string(value) as T;
    }
    if (Array.isArray(value)) return value.map((v) => this.apply(v, key)) as T;
    if (!isPlain(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      out[k] = PHONE_KEYS.has(k) && Array.isArray(v) ? v.map(() => '+1 555 0100') : this.apply(v, k);
    return out as T;
  }

  /** Pass 2 over a URL: each path segment and query value is sanitized and re-encoded. */
  url(url: string): string {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map((seg) => (seg ? encodeURIComponent(this.string(safeDecode(seg))).replace(/%24/g, '$') : seg))
      .join('/');
    const params = [...u.searchParams].map(([k, v]) => {
      const value = /^\$?skip[Tt]oken$|^skiptoken$/.test(k) ? this.token(v) : this.string(v);
      return `${encodeURIComponent(k).replace(/%24/g, '$')}=${encodeURIComponent(value)}`;
    });
    return `${u.protocol}//${this.domain(u.hostname)}${u.port ? `:${u.port}` : ''}${path}${params.length ? `?${params.join('&')}` : ''}`;
  }

  /** Names of forbidden values (by index) that still occur in `text`; empty = clean. */
  leaks(text: string): number[] {
    const lower = text.toLowerCase();
    return this.forbidden.flatMap((f, i) => (lower.includes(f.toLowerCase()) ? [i] : []));
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The collection a Graph/ARM path is about (kind for synthetic display names). */
export function kindFromPath(pathname: string): string {
  const segs = pathname.toLowerCase().split('/').filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const k = KIND_OF[segs[i]!.replace(/^microsoft\.graph\./, '')];
    if (k) return k;
  }
  return 'Item';
}
