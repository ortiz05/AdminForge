import path from 'node:path';
import { lintExpressions } from '@adminforge/expressions';
import { isWriteCapable, loadContentDir, type Probe, type Schedule } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const probes = loaded.definitions.filter((d) => d.def.kind === 'probe') as Array<{ file: string; def: Probe }>;
const schedules = loaded.definitions.filter((d) => d.def.kind === 'schedule') as Array<{ file: string; def: Schedule }>;
const active = (status?: string) => status !== 'draft' && status !== 'retired';

const CONFIG_CHECKS = [
  'probes.storage-public-blob-access',
  'probes.storage-insecure-transport',
  'probes.nsg-open-management-ports',
  'probes.key-vault-purge-protection',
  'probes.arc-machines-disconnected',
  'probes.policy-non-compliance',
  'probes.defender-high-severity-recommendations',
  'probes.resources-missing-required-tags',
  'probes.activity-failed-writes-spike',
  'probes.risky-oauth-consents',
];

describe('probe sweeps', () => {
  const sweeps = schedules.filter((s) => s.def.job.kind === 'probe');
  const selects = (s: Schedule, p: Probe) => {
    const job = s.job.kind === 'probe' ? s.job : undefined;
    if (!job) return false;
    if (job.ref) return job.ref === p.id;
    if (job.refs) return job.refs.includes(p.id);
    return active(p.status) && job.select!.tags.every((t) => p.tags?.includes(t));
  };

  it('replace the per-probe schedules with a few tag-based sweeps', () => {
    expect(sweeps.length).toBeLessThanOrEqual(6);
    expect(sweeps.every((s) => s.def.job.kind === 'probe' && !!s.def.job.select)).toBe(true);
  });
  it('run every active probe in exactly one enabled sweep', () => {
    const enabled = sweeps.filter((s) => s.def.enabled && active(s.def.status));
    const coverage = probes.filter((p) => active(p.def.status)).map((p) => [p.def.id, enabled.filter((s) => selects(s.def, p.def)).map((s) => s.def.id)] as const);
    expect(coverage.filter(([, by]) => by.length !== 1)).toEqual([]);
  });
  it('are read-only, start enabled and never overlap themselves', () => {
    for (const s of sweeps) expect([s.def.id, isWriteCapable(s.def), s.def.enabled, s.def.overlap]).toEqual([s.def.id, false, true, 'skip']);
  });
});

describe('KQL configuration checks', () => {
  const kql = probes.filter((p) => p.def.check.kind === 'kql');
  const check = (p: Probe) => p.check as Extract<Probe['check'], { kind: 'kql' }>;

  it('ship the agreed set', () => expect(kql.map((p) => p.def.id).sort()).toEqual([...CONFIG_CHECKS].sort()));
  it('declare thresholds and keep the offending rows as details', () => {
    for (const p of kql) {
      expect([p.def.id, p.def.thresholds?.warn !== undefined || p.def.thresholds?.crit !== undefined]).toEqual([p.def.id, true]);
      expect([p.def.id, check(p.def).detailsLimit > 0]).toEqual([p.def.id, true]);
      expect(p.def.summary?.length ?? 0).toBeGreaterThan(40);
    }
  });
  it('need the right access for their source', () => {
    for (const p of kql) {
      const c = check(p.def);
      if (c.source === 'resourceGraph') expect([p.def.id, p.def.requires?.azureRoles]).toEqual([p.def.id, ['Reader']]);
      if (c.source === 'logAnalytics') expect([p.def.id, p.def.requires?.azureRoles]).toEqual([p.def.id, ['Log Analytics Reader']]);
      if (c.source === 'advancedHunting') expect(p.def.requires).toMatchObject({ scopes: { graph: ['ThreatHunting.Read.All'] }, licences: ['defender'] });
    }
  });
  it('use only KQL Resource Graph supports (no let statements) and no literal workspaces', () => {
    for (const p of kql) {
      const c = check(p.def);
      if (c.source === 'resourceGraph') expect([p.def.id, /(^|\n)\s*let\s/.test(c.query)]).toEqual([p.def.id, false]);
      expect([p.def.id, c.workspace]).toEqual([p.def.id, undefined]);
      expect(c.query).toContain(`// af:${p.def.id}`);
    }
  });
  it('quote any user data with $kql()', () => expect(kql.flatMap((p) => lintExpressions(p.def).map((w) => `${p.file} ${w.path}: ${w.message}`))).toEqual([]));
  it('are swept with the configuration checks, except the hourly activity spike', () => {
    for (const p of kql) expect([p.def.id, p.def.tags?.includes('config-check') ? 'config' : p.def.tags?.find((t) => t.startsWith('sweep-'))]).toEqual([p.def.id, p.def.id === 'probes.activity-failed-writes-spike' ? 'sweep-1h' : 'config']);
  });
});
