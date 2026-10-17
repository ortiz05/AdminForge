import { lintExpressions, validateExpressions } from '@adminforge/expressions';
import {
  formatContentError,
  identityKey,
  KINDS,
  validateDefinition,
  validateReferences,
  type ContentError,
  type DefinitionEntry,
  type Scopes,
} from '@adminforge/schemas';
import type { DefinitionSource } from '../definitions/types';
import type { ExecutionIdentity, OutboundExecutor } from '../execution/types';

/**
 * `job: contentHealth` (R6): re-validates every published definition against the current schemas and cross-references,
 * compiles every expression, runs the expression lint, and (with `scopes: true`) compares the application permissions
 * schedules and probes declare with what the automation identity actually holds ("scope drift").
 */

const CHECKED = [
  'graph',
  'logAnalytics',
  'exchange',
  'sharepointAdmin',
  'teams',
] as const satisfies ReadonlyArray<keyof Scopes>;

/** Microsoft first-party resource app ids (the same in every tenant) for app-only permissions. */
const RESOURCE_APP_IDS: Record<string, (typeof CHECKED)[number]> = {
  '00000003-0000-0000-c000-000000000000': 'graph',
  'ca7f3f0b-7d91-482c-8e09-c5d840d0eac5': 'logAnalytics',
  '00000002-0000-0ff1-ce00-000000000000': 'exchange',
  '00000003-0000-0ff1-ce00-000000000000': 'sharepointAdmin',
  '48ac35b8-9aa8-4d74-927d-1f4a14a0b239': 'teams',
};

export interface ScopeDrift {
  checked: boolean;
  /** Declared by an active schedule/probe but not granted: `graph:AuditLog.Read.All`. */
  missing: string[];
  /** Granted but declared by nothing. */
  unused: string[];
  /** Definitions not checked because the tenant lacks a licence they require (their permissions wait for it). */
  unlicensed?: string[];
  reason?: string;
  /**
   * The same check for each named app identity schedules run as (ADR-014), by name: what its schedules declare
   * against what that identity holds.
   */
  identities?: Record<string, Omit<ScopeDrift, 'identities' | 'unlicensed'>>;
}

export interface ContentHealthReport {
  definitions: number;
  problems: number;
  /** First problems, as `file:line path: message`. */
  problemSamples: string[];
  lintWarnings: number;
  lintSamples: string[];
  scopes: ScopeDrift | null;
}

const ACTIVE = (status: string | undefined) => status !== 'draft' && status !== 'retired';

/** `X.ReadWrite.Y` also grants `X.Read.Y`. */
const satisfied = (have: Set<string>, want: string) => {
  const w = want.toLowerCase();
  return (
    have.has(w) ||
    have.has(w.replace('.read.', '.readwrite.')) ||
    (w.endsWith('.read') && have.has(`${w.slice(0, -5)}.readwrite`))
  );
};

/** The automation identity's app role assignments as `service:Permission` (lower-case), via Graph as the automation identity. */
export async function grantedAppRoles(
  outbound: OutboundExecutor,
  clientId: string,
  opts: { correlationId?: string; signal?: AbortSignal } = {},
): Promise<Set<string>> {
  const id: ExecutionIdentity = { kind: 'automation', mode: 'read' };
  const sps = await outbound.execute<{ value?: Array<{ id: string }> }>(
    id,
    {
      service: 'graph',
      method: 'GET',
      path: '/servicePrincipals',
      query: { $filter: `appId eq '${clientId.replace(/'/g, "''")}'`, $select: 'id' },
    },
    opts,
  );
  const sp = sps.data?.value?.[0];
  if (!sp) throw new Error('The automation identity has no service principal in this tenant.');
  const assignments = await outbound.execute<{ value?: Array<{ resourceId: string; appRoleId: string }> }>(
    id,
    {
      service: 'graph',
      method: 'GET',
      path: `/servicePrincipals/${encodeURIComponent(sp.id)}/appRoleAssignments`,
      paging: 'all',
      maxItems: 2000,
    },
    opts,
  );
  const resources = new Map<
    string,
    { appId?: string; appRoles?: Array<{ id: string; value?: string | null }> } | null
  >();
  const out = new Set<string>();
  for (const a of assignments.data?.value ?? []) {
    if (!resources.has(a.resourceId)) {
      const r = await outbound
        .execute<{ appId?: string; appRoles?: Array<{ id: string; value?: string | null }> }>(
          id,
          {
            service: 'graph',
            method: 'GET',
            path: `/servicePrincipals/${encodeURIComponent(a.resourceId)}`,
            query: { $select: 'appId,appRoles' },
          },
          opts,
        )
        .then((x) => x.data)
        .catch(() => null);
      resources.set(a.resourceId, r);
    }
    const res = resources.get(a.resourceId);
    const service = res?.appId ? RESOURCE_APP_IDS[res.appId] : undefined;
    const value = res?.appRoles?.find((r) => r.id === a.appRoleId)?.value;
    if (service && value) out.add(`${service}:${value.toLowerCase()}`);
  }
  return out;
}

export async function contentHealth(
  definitions: Pick<DefinitionSource, 'list' | 'problems'>,
  opts: {
    scopes?: boolean;
    outbound?: OutboundExecutor;
    automationClientId?: string | null;
    /** Application ids of the named app identities (ADR-014), by name. */
    identityClientIds?: Readonly<Record<string, string>>;
    /** Whether the tenant holds one of these licences (null = unknown → checked as usual). */
    licensed?: (licences: string[]) => Promise<boolean | null>;
    correlationId?: string;
    signal?: AbortSignal;
  },
): Promise<ContentHealthReport> {
  const records = await definitions.list();
  const errors: ContentError[] = [...definitions.problems()];
  const entries: DefinitionEntry[] = [];
  for (const r of records) {
    if (!(KINDS as readonly string[]).includes(r.kind)) continue;
    const file = r.file ?? `${r.kind}:${r.key}@${r.version}`;
    const v = validateDefinition(r.def, file);
    if (!v.ok) errors.push(...v.errors);
    else entries.push({ file, def: v.def });
    for (const i of validateExpressions(r.def)) errors.push({ file, path: i.path, message: i.message });
  }
  errors.push(...validateReferences(entries));
  const lint = entries.flatMap((e) => lintExpressions(e.def).map((w) => `${e.file} ${w.path}: ${w.message}`));

  let scopes: ScopeDrift | null = null;
  if (opts.scopes) {
    // What each app-only identity's work declares: the automation identity's (schedules, probes, feeds) and every
    // named app identity's (the schedules naming it). Creators' schedules use delegated access: not app roles.
    const byIdentity = new Map<string, Map<string, string[]>>([['automation', new Map()]]);
    const unlicensed: string[] = [];
    for (const e of entries) {
      // Everything the automation identity runs: schedules, probes and News and changes feeds.
      if (
        (e.def.kind !== 'schedule' && e.def.kind !== 'probe' && e.def.kind !== 'feed') ||
        !ACTIVE(e.def.status)
      )
        continue;
      if (e.def.kind === 'schedule' && e.def.enabled === false) continue;
      const licences = e.def.requires?.licences;
      if (licences?.length && opts.licensed && (await opts.licensed(licences)) === false) {
        unlicensed.push(e.def.id);
        continue;
      }
      const who = e.def.kind === 'schedule' ? identityKey(e.def.identity) : 'automation';
      if (who === 'user') continue;
      const name = who.startsWith('app:') ? who.slice(4) : 'automation';
      const declared = byIdentity.get(name) ?? new Map<string, string[]>();
      byIdentity.set(name, declared);
      for (const service of CHECKED)
        for (const s of e.def.requires?.scopes?.[service] ?? [])
          declared.set(`${service}:${s}`, [...(declared.get(`${service}:${s}`) ?? []), e.file]);
    }
    const declared = byIdentity.get('automation')!;
    // Drift of one app-only identity: declared but not granted, granted but declared by nothing.
    const drift = async (clientId: string, wanted: Map<string, string[]>) => {
      const granted = await grantedAppRoles(opts.outbound!, clientId, {
        correlationId: opts.correlationId,
        signal: opts.signal,
      });
      const missing = [...wanted.keys()].filter((k) => {
        const [service, scope] = k.split(':') as [string, string];
        return !satisfied(
          new Set(
            [...granted].filter((g) => g.startsWith(`${service}:`)).map((g) => g.slice(service.length + 1)),
          ),
          scope,
        );
      });
      const wantedLower = [...wanted.keys()].map((k) => k.toLowerCase());
      const unused = [...granted].filter(
        (g) => !wantedLower.some((d) => d === g || d === g.replace('.readwrite.', '.read.')),
      );
      return { checked: true, missing: missing.sort(), unused: unused.sort() };
    };
    const identities: Record<string, Omit<ScopeDrift, 'identities' | 'unlicensed'>> = {};
    for (const [name, wanted] of byIdentity) {
      if (name === 'automation') continue;
      const clientId = opts.identityClientIds?.[name];
      if (!clientId || !opts.outbound) {
        identities[name] = {
          checked: false,
          missing: [],
          unused: [],
          reason: `The app identity ${name} isn’t configured on this AdminForge.`,
        };
        continue;
      }
      try {
        identities[name] = await drift(clientId, wanted);
      } catch (err) {
        identities[name] = { checked: false, missing: [], unused: [], reason: (err as Error).message };
      }
    }
    const named = Object.keys(identities).length ? { identities } : {};
    if (!opts.outbound || !opts.automationClientId)
      scopes = {
        checked: false,
        missing: [],
        unused: [],
        reason: 'The automation identity is not configured.',
        ...named,
      };
    else {
      try {
        scopes = {
          ...(await drift(opts.automationClientId, declared)),
          ...(unlicensed.length ? { unlicensed: unlicensed.sort() } : {}),
          ...named,
        };
      } catch (err) {
        scopes = { checked: false, missing: [], unused: [], reason: (err as Error).message, ...named };
      }
    }
  }
  return {
    definitions: records.length,
    problems: errors.length,
    problemSamples: errors.slice(0, 25).map(formatContentError),
    lintWarnings: lint.length,
    lintSamples: lint.slice(0, 25),
    scopes,
  };
}
