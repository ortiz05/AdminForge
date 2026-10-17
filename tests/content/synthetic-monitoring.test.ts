import path from 'node:path';
import { selectProbes } from '@adminforge/api/src/schedules/jobs';
import type { DefinitionRecord } from '@adminforge/api/src/definitions/types';
import { renderString } from '@adminforge/expressions';
import {
  TRANSACTION_KINDS,
  loadContentDir,
  type Navigation,
  type Probe,
  type ProbeJob,
  type Schedule,
} from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Synthetic monitoring of Microsoft 365: every probe names the service it watches (the monitoring page groups by it,
// each service section links to its own checks), the synthetic transactions run in their own sweep against test
// objects from configuration only, each workload has read-only checks too, and service-health filters use the names
// Microsoft uses today.

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const defs = loaded.definitions.map((d) => d.def);
const active = defs.filter((d) => d.status !== 'retired' && d.status !== 'draft');
const probes = active.filter((d): d is Probe => d.kind === 'probe');
const navigation = defs.find((d) => d.id === 'portal.navigation') as Navigation;
const sections = new Set(navigation.sections.map((s) => s.key));
const probe = (id: string) => {
  const p = probes.find((x) => x.id === id);
  if (!p) throw new Error(`${id} is missing or not active`);
  return p;
};

describe('synthetic monitoring content', () => {
  it('every active probe names the service it watches (a navigation section or platform)', () => {
    expect(probes.filter((p) => !p.group).map((p) => p.id)).toEqual([]);
    expect(probes.filter((p) => p.group !== 'platform' && !sections.has(p.group!)).map((p) => p.id)).toEqual(
      [],
    );
  });

  it('each Microsoft 365 workload has a mix of checks, and its section links to them', () => {
    const want: Record<string, string[]> = {
      exchange: ['mailFlow', 'http', 'graphCount', 'signInHealth', 'dnsResolve'],
      sharepoint: ['fileRoundTrip', 'http', 'graphCount', 'signInHealth'],
      teams: ['onlineMeeting', 'graph', 'http', 'graphCount', 'signInHealth'],
      identity: ['http', 'graphCount', 'signInHealth'],
      endpoint: ['graph', 'graphCount'],
      m365: ['http', 'graph', 'graphCount'],
    };
    for (const [group, kinds] of Object.entries(want)) {
      const have = new Set(probes.filter((p) => p.group === group).map((p) => p.check.kind));
      expect(
        [...kinds].filter((k) => !have.has(k as Probe['check']['kind'])),
        group,
      ).toEqual([]);
    }
    // Every section with probes links to them; AdminForge's own checks (tokens, readiness) stay under Automation.
    for (const group of new Set(probes.map((p) => p.group!).filter((g) => g !== 'platform'))) {
      const items = navigation.sections.find((s) => s.key === group)?.items ?? [];
      expect(
        items.map((i) => i.href),
        group,
      ).toContain(`/monitoring?group=${group}`);
    }
    expect(
      probes.filter((p) => p.check.kind === 'tokenAcquisition').every((p) => p.group === 'platform'),
    ).toBe(true);
  });

  it('runs the synthetic transactions, and only them, in their own 15-minute sweep', async () => {
    const sweep = active.find((d) => d.id === 'sweep.synthetic-transactions') as Schedule;
    expect(sweep).toMatchObject({ enabled: true, identity: 'automation', every: 'every 15 minutes' });
    const records = probes.map((p) => ({ kind: 'probe', key: p.id, def: p }) as unknown as DefinitionRecord);
    const registry = {
      list: async () => records,
      resolve: async () => {
        throw new Error('not used');
      },
    };
    const picked = await selectProbes(sweep.job as ProbeJob, registry as never);
    expect(picked.map((p) => p.key).sort()).toEqual([
      'probes.exchange-mail-flow',
      'probes.sharepoint-file-round-trip',
      'probes.teams-online-meeting',
    ]);
    // Every transaction is in that sweep and in no other; nothing else is.
    const tx = probes.filter((p) => (TRANSACTION_KINDS as readonly string[]).includes(p.check.kind));
    expect(tx.every((p) => p.tags?.includes('synthetic-transaction'))).toBe(true);
    expect(tx.some((p) => p.tags?.some((t) => /^sweep-/.test(t)))).toBe(false);
    expect(probes.filter((p) => p.tags?.includes('synthetic-transaction')).every((p) => tx.includes(p))).toBe(
      true,
    );
  });

  it('points the transactions at test objects from configuration only', () => {
    expect(probe('probes.exchange-mail-flow').check).toMatchObject({
      from: '${ env.AF_MAIL_SENDER }',
      to: '${ env.AF_SYNTHETIC_MAILBOX }',
      cleanup: true,
    });
    expect(probe('probes.sharepoint-file-round-trip').check).toMatchObject({
      site: '${ env.AF_SYNTHETIC_SITE_ID }',
    });
    expect(probe('probes.teams-online-meeting').check).toMatchObject({
      organizer: '${ env.AF_SYNTHETIC_USER_ID }',
    });
  });

  it('filters OneDrive service health on both of its names', () => {
    for (const id of ['probes.onedrive-service-incidents']) {
      const filter = String((probe(id).check as { query?: Record<string, unknown> }).query?.$filter);
      expect(filter, id).toMatch(/'Microsoft OneDrive'/);
      expect(filter, id).toMatch(/'OneDrive for Business'/);
    }
  });

  it('names only services Microsoft reports in service health (a misspelt one would never alert)', () => {
    // As GET /admin/serviceAnnouncement/healthOverviews named them on 2026-10-17 (plus OneDrive's former name).
    const known = new Set([
      'Exchange Online',
      'SharePoint Online',
      'Microsoft OneDrive',
      'OneDrive for Business',
      'Microsoft Teams',
      'Microsoft Entra',
      'Microsoft Intune',
      'Microsoft 365 suite',
      'Microsoft 365 apps',
    ]);
    const incidents = probes.filter((p) => p.id.endsWith('-incidents'));
    expect(incidents.length).toBeGreaterThanOrEqual(7);
    for (const p of incidents) {
      const filter = String((p.check as { query?: Record<string, unknown> }).query?.$filter);
      const names = [...filter.matchAll(/service eq '([^']+)'/g)].map((m) => m[1]!);
      expect(names.length, p.id).toBeGreaterThan(0);
      expect(
        names.filter((n) => !known.has(n)),
        p.id,
      ).toEqual([]);
    }
  });

  it('counts only interrupted services (advisories keep several services degraded most days)', async () => {
    const check = probe('probes.m365-services-interrupted').check as { items: string };
    const value = [
      { service: 'Exchange Online', status: 'serviceDegradation' },
      { service: 'Microsoft OneDrive', status: 'serviceInterruption' },
      { service: 'Microsoft Teams', status: 'serviceOperational' },
    ];
    const picked = await renderString(check.items, { value });
    expect([picked].flat()).toEqual([{ service: 'Microsoft OneDrive', status: 'serviceInterruption' }]);
  });

  it('the SharePoint overview reports Microsoft OneDrive under either name', async () => {
    const dash = defs.find((d) => d.id === 'sharepoint.overview') as {
      datasources: Record<string, { transform: string }>;
    };
    const out = (await renderString(dash.datasources.health!.transform, {
      value: {
        value: [
          { service: 'SharePoint Online', status: 'serviceOperational' },
          { service: 'Microsoft OneDrive', status: 'serviceInterruption' },
        ],
      },
    })) as Record<string, unknown>;
    expect(out).toMatchObject({ label: 'Interrupted', tone: 'crit', services: 'Microsoft OneDrive' });
  });
});
