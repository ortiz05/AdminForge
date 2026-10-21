import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  EmptyState,
  GearIcon,
  IdChip,
  PageHeader,
  Panel,
  SkeletonText,
  STATUS_ICON,
  StatusPill,
} from '@adminforge/ui';
import { api } from '../lib/api';
import { useMe } from '../lib/session';
import { bool, num, parser, pick, rec } from '../runs/json';
import { EmergencyCard } from './EmergencyCard';
import { Callout, Facts, isForbidden, QueryError, useDocumentTitle } from './ui';

/**
 * GET /api/admin/settings (Portal.Admin) — read-only installation facts. The API answers today:
 *   { authMode, dataMode, contentSource, writeSessionMaxMinutes, writeStepUp, auditChain: { keyed, since?, pinned? },
 *     apps: { read, write, automation }: boolean, tenant: { name, domain } }
 * and the page also shows these optional fields when present (see the report for the full wish list):
 *   environment: { label, nodeEnv, publicBaseUrl, version } · writeAuthContext · sessionIdleMinutes · sessionAbsoluteHours
 *   content: { watch, definitions, problems } · database: { configured } · apps.<key>: { present, clientId, credential } · apps.runner
 * Secrets are never part of it: only whether something is configured.
 */

interface AppStatus {
  present: boolean;
  clientId: string | null;
  credential: string | null;
}

export interface SettingsResponse {
  tenant: { name: string | null; domain: string | null };
  environment: {
    label: string | null;
    nodeEnv: string | null;
    publicBaseUrl: string | null;
    version: string | null;
  };
  authMode: 'entra' | 'mock';
  dataMode: 'live' | 'fixtures';
  contentSource: 'fs' | 'db';
  content: { watch: boolean | null; definitions: number | null; problems: number | null };
  writeSessionMaxMinutes: number | null;
  writeAuthContext: string | null;
  /** How arming proves the person: an authentication context (MFA per policy) or only a fresh sign-in. */
  writeStepUp: 'authContext' | 'freshSignIn' | 'none' | null;
  sessionIdleMinutes: number | null;
  sessionAbsoluteHours: number | null;
  apps: Array<{ key: string; label: string; purpose: string; status: AppStatus }>;
  database: { configured: boolean | null };
  /** Whether the audit log is HMAC-keyed (AUDIT_CHAIN_KEY) and since which event; null when the API doesn't say. */
  auditChain: { keyed: boolean; since: number | null; pinned: boolean } | null;
}

const APPS: Array<{ key: string; label: string; purpose: string }> = [
  {
    key: 'read',
    label: 'AdminForge (Read)',
    purpose: 'Sign-in and every read, with the engineer’s own delegated permissions.',
  },
  {
    key: 'write',
    label: 'AdminForge (Write)',
    purpose: 'Write access while armed; targeted by the step-up Conditional Access policy.',
  },
  {
    key: 'automation',
    label: 'Automation identity',
    purpose: 'Schedules and probes, with application permissions (certificate preferred).',
  },
  {
    key: 'runner',
    label: 'Runner API',
    purpose: 'Lets the BFF call the PowerShell runner for Exchange, Teams and SharePoint.',
  },
];

/** `true` / `false`, or `{ present, clientId?, credential? }`. */
const readApp = (v: unknown): AppStatus | null => {
  if (typeof v === 'boolean') return { present: v, clientId: null, credential: null };
  if (v === undefined || v === null) return null;
  const o = rec(v);
  return {
    present: bool(o.present) ?? bool(o.configured) ?? false,
    clientId: pick(o, 'clientId') ?? null,
    credential: pick(o, 'credential') ?? null,
  };
};

const stepUp = (v: string | undefined): SettingsResponse['writeStepUp'] =>
  v === 'authContext' || v === 'freshSignIn' || v === 'none' ? v : null;

const SettingsParser = parser((input): SettingsResponse => {
  const o = rec(input);
  const auth = rec(o.auth);
  const content = rec(o.content);
  const env = rec(o.environment);
  const apps = rec(o.apps);
  const authMode = pick(o, 'authMode') ?? pick(auth, 'mode');
  if (!authMode) throw new TypeError('Expected { authMode }');
  const chain = rec(o.auditChain);
  const chainKeyed = bool(chain.keyed);
  return {
    tenant: {
      name: pick(rec(o.tenant), 'name') ?? null,
      domain: pick(rec(o.tenant), 'domain') ?? pick(auth, 'primaryDomain') ?? null,
    },
    environment: {
      label: pick(env, 'label') ?? null,
      nodeEnv: pick(env, 'nodeEnv') ?? null,
      publicBaseUrl: pick(env, 'publicBaseUrl') ?? null,
      version: pick(env, 'version') ?? null,
    },
    authMode: authMode === 'mock' ? 'mock' : 'entra',
    dataMode: (pick(o, 'dataMode') ?? pick(rec(o.data), 'mode')) === 'fixtures' ? 'fixtures' : 'live',
    contentSource: (pick(o, 'contentSource') ?? pick(content, 'source')) === 'db' ? 'db' : 'fs',
    content: {
      watch: bool(content.watch) ?? null,
      definitions: num(content.definitions) ?? null,
      problems: num(content.problems) ?? null,
    },
    writeSessionMaxMinutes: num(o.writeSessionMaxMinutes) ?? num(rec(o.writeSession).maxMinutes) ?? null,
    writeAuthContext: pick(o, 'writeAuthContext') ?? pick(auth, 'writeAuthContext') ?? null,
    writeStepUp: stepUp(pick(o, 'writeStepUp')),
    sessionIdleMinutes: num(o.sessionIdleMinutes) ?? num(rec(o.writeSession).idleMinutes) ?? null,
    sessionAbsoluteHours: num(o.sessionAbsoluteHours) ?? num(rec(o.writeSession).absoluteHours) ?? null,
    apps: APPS.flatMap((a) => {
      const status = readApp(apps[a.key]);
      return status ? [{ ...a, status }] : [];
    }),
    database: { configured: bool(rec(o.database).configured) ?? null },
    auditChain:
      chainKeyed === undefined
        ? null
        : { keyed: chainKeyed, since: num(chain.since) ?? null, pinned: bool(chain.pinned) ?? false },
  };
});

function Present({
  ok,
  yes = 'Configured',
  no = 'Not configured',
}: {
  ok: boolean | null;
  yes?: string;
  no?: string;
}) {
  if (ok === null) return <span className="text-fg-3">Unknown</span>;
  const Glyph = STATUS_ICON[ok ? 'ok' : 'crit'];
  return (
    <span className={`inline-flex items-center gap-1.5 font-medium ${ok ? 'text-ok' : 'text-crit'}`}>
      <Glyph size={14} weight="fill" aria-hidden />
      {ok ? yes : no}
    </span>
  );
}

/**
 * The audit log's key (S-10): keyed since which event, or an Unkeyed warning, with what it means underneath — words
 * that wrap (a pill truncates on a phone).
 */
function AuditChainFact({ chain }: { chain: NonNullable<SettingsResponse['auditChain']> }) {
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      {chain.keyed ? (
        <span>Keyed{chain.since !== null ? ` since event ${chain.since.toLocaleString('en-US')}` : ''}</span>
      ) : (
        <StatusPill status="warn" size="sm">
          Unkeyed
        </StatusPill>
      )}
      <span className="max-w-full text-xs break-words text-fg-3">
        {!chain.keyed
          ? 'Set AUDIT_CHAIN_KEY so changing an event needs a key the database doesn’t hold.'
          : chain.pinned
            ? 'Changing an event needs the key, and the keyed part is pinned (AUDIT_CHAIN_KEYED_SINCE).'
            : 'Changing an event needs the key. Set AUDIT_CHAIN_KEYED_SINCE to this event so removing the keyed part is caught too.'}
      </span>
    </span>
  );
}

/** Settings (Portal.Admin): how this AdminForge is configured — read-only; configuration lives in the env file. */
export function SettingsPage() {
  const me = useMe();
  useDocumentTitle('Settings');
  const q = useQuery({
    queryKey: ['admin', 'settings'] as const,
    queryFn: ({ signal }) => api('/api/admin/settings', { schema: SettingsParser, signal }),
    retry: false,
  });

  if (q.isError && isForbidden(q.error))
    return (
      <>
        <PageHeader eyebrow="Admin" title="Settings" />
        <div className="flex flex-col gap-6">
          {/* Playbook Approvers may pause (not resume) changes and automation; the card hides itself otherwise. */}
          <EmergencyCard />
          <Panel>
            <EmptyState title="Settings are for Portal Admins" icon={<GearIcon size={20} />}>
              {me.user.upn} doesn’t have the Portal Admin role.
            </EmptyState>
          </Panel>
        </div>
      </>
    );

  const s = q.data;
  const missingApps = s?.apps.filter((a) => !a.status.present) ?? [];
  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Settings"
        description="How this AdminForge is configured. Values come from the local env file (never from the repository); change them there and restart."
        meta={s?.environment.label && <Badge mono>{s.environment.label}</Badge>}
      />
      {q.isError ? (
        <Panel>
          <QueryError title="Settings didn’t load" error={q.error} onRetry={() => void q.refetch()} />
        </Panel>
      ) : !s ? (
        <div className="grid gap-6 xl:grid-cols-2" aria-busy="true">
          <Panel>
            <SkeletonText lines={5} />
          </Panel>
          <Panel>
            <SkeletonText lines={5} />
          </Panel>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {s.authMode === 'mock' && (
            <Callout tone="warn" title="Mock sign-in is on">
              Anyone who reaches this host signs in as the mock engineer. Use it only for local development;
              production refuses to start with AUTH_MODE=mock.
            </Callout>
          )}
          {missingApps.length > 0 && (
            <Callout tone="warn" title={`Not provisioned: ${missingApps.map((a) => a.label).join(', ')}`}>
              Run <code className="font-mono text-xs">pnpm adminforge provision entra</code> to create the app
              registrations; it writes their ids to your local env file.
            </Callout>
          )}
          <EmergencyCard />
          <div className="grid items-start gap-6 xl:grid-cols-2">
            <Panel eyebrow="Identity" title="Sign-in and write access">
              <Facts
                items={[
                  [
                    'Tenant',
                    s.tenant.name
                      ? `${s.tenant.name}${s.tenant.domain ? ` · ${s.tenant.domain}` : ''}`
                      : s.tenant.domain,
                  ],
                  [
                    'Auth mode',
                    s.authMode === 'mock' ? (
                      <StatusPill key="m" status="warn" size="sm">
                        Mock sign-in
                      </StatusPill>
                    ) : (
                      'Microsoft Entra ID'
                    ),
                  ],
                  [
                    'Write session cap',
                    s.writeSessionMaxMinutes ? `${s.writeSessionMaxMinutes} minutes` : null,
                  ],
                  [
                    'Write step-up',
                    s.writeStepUp === 'authContext' ? (
                      'Authentication context (your Conditional Access policy decides, e.g. MFA)'
                    ) : s.writeStepUp === 'freshSignIn' ? (
                      <StatusPill key="s" status="warn" size="sm">
                        Fresh sign-in only — set WRITE_AUTH_CONTEXT to require MFA
                      </StatusPill>
                    ) : null,
                  ],
                  ...(s.writeAuthContext !== null
                    ? ([
                        [
                          'Step-up context',
                          <code key="c" className="font-mono text-xs">
                            {s.writeAuthContext}
                          </code>,
                        ],
                      ] as Array<[string, ReactNode]>)
                    : []),
                  ...(s.sessionIdleMinutes !== null
                    ? ([['Idle sign-out', `${s.sessionIdleMinutes} minutes`]] as Array<[string, ReactNode]>)
                    : []),
                  ...(s.sessionAbsoluteHours !== null
                    ? ([['Session lifetime', `${s.sessionAbsoluteHours} hours`]] as Array<
                        [string, ReactNode]
                      >)
                    : []),
                ]}
              />
            </Panel>
            <Panel eyebrow="Data" title="Where data and content come from">
              <Facts
                items={[
                  [
                    'Data mode',
                    s.dataMode === 'fixtures' ? (
                      <StatusPill key="d" status="warn" size="sm">
                        Fixtures (synthetic)
                      </StatusPill>
                    ) : (
                      'Live Microsoft APIs'
                    ),
                  ],
                  [
                    'Content source',
                    s.contentSource === 'fs'
                      ? 'portal/content on disk'
                      : 'Published versions in the database',
                  ],
                  ...(s.content.watch !== null
                    ? ([['Hot reload', s.content.watch ? 'On' : 'Off']] as Array<[string, ReactNode]>)
                    : []),
                  ...(s.content.definitions !== null
                    ? ([['Definitions loaded', s.content.definitions.toLocaleString('en-US')]] as Array<
                        [string, ReactNode]
                      >)
                    : []),
                  ...(s.content.problems !== null
                    ? ([
                        [
                          'Content problems',
                          s.content.problems ? (
                            <span key="p" className="font-medium text-crit">
                              {s.content.problems}
                            </span>
                          ) : (
                            'None'
                          ),
                        ],
                      ] as Array<[string, ReactNode]>)
                    : []),
                  ...(s.database.configured !== null
                    ? ([['Database', <Present key="db" ok={s.database.configured} />]] as Array<
                        [string, ReactNode]
                      >)
                    : []),
                  ...(s.auditChain
                    ? ([['Audit log', <AuditChainFact key="a" chain={s.auditChain} />]] as Array<
                        [string, ReactNode]
                      >)
                    : []),
                  ...(s.environment.version
                    ? ([['Version', s.environment.version]] as Array<[string, ReactNode]>)
                    : []),
                ]}
              />
            </Panel>
          </div>
          <Panel eyebrow="App registrations" title="Provisioned apps" flush>
            <ul className="flex flex-col">
              {s.apps.map((a) => (
                <li
                  key={a.key}
                  className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line px-(--af-pad-panel) py-3 first:border-t-0"
                >
                  <span className="flex min-w-60 flex-1 flex-col">
                    <span className="font-medium text-fg">{a.label}</span>
                    <span className="text-xs text-fg-3">{a.purpose}</span>
                  </span>
                  <span className="w-36">
                    <Present ok={a.status.present} yes="Present" no="Missing" />
                  </span>
                  {a.status.clientId && <IdChip value={a.status.clientId} label="Client ID" />}
                  {a.key === 'automation' && a.status.present && a.status.credential && (
                    <Badge tone={a.status.credential === 'certificate' ? 'ok' : 'warn'}>
                      {a.status.credential === 'certificate' ? 'Certificate' : 'Client secret'}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      )}
    </>
  );
}
