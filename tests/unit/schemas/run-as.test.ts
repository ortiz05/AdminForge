import { effectiveIdentity, type Schedule } from '@adminforge/schemas';
import { ENVELOPE, ok } from './helpers';

// Which account a schedule runs as (docs/plans/2026-10-23-run-as-and-vault.md): its portal override, else the identity
// its definition names, else the installation default for its kind (read-only jobs only), else the automation
// identity. News and content health always run as the automation identity.
const cron = 'cron: "0 7 * * 1"\n';
const def = (job: string, extra = '') =>
  ok<Schedule>(`${ENVELOPE('schedule', 'reports.x')}${cron}${extra}${job}`);
const report = def('job:\n  kind: report\n  ref: identity.inactive-users\n  delivery: [{ type: file }]\n');
const probe = def('job:\n  kind: probe\n  select: { tags: [sweep-15m] }\n');
const readPlaybook = def('job:\n  kind: playbook\n  ref: identity.disable-user\n  mode: read\n');
const writePlaybook = def(
  'job:\n  kind: playbook\n  ref: identity.disable-user\n  mode: write\n  approvedBy: [approver@example.com]\n',
);
const news = def('job:\n  kind: news\n');
const named = def(
  'job:\n  kind: report\n  ref: identity.inactive-users\n  delivery: [{ type: file }]\n',
  'identity: { app: intune-ops }\n',
);
const defaults = { all: 'ops-team', reports: 'reports-team', probes: 'automation' };

describe('effectiveIdentity', () => {
  it('runs as the automation identity with nothing configured', () => {
    for (const d of [report, probe, readPlaybook, writePlaybook])
      expect(effectiveIdentity(d)).toEqual({ identity: 'automation', source: 'automation' });
  });

  it('takes the default for its kind, then the general one, for read-only jobs', () => {
    expect(effectiveIdentity(report, { defaults })).toEqual({
      identity: { app: 'reports-team' },
      source: 'default',
    });
    expect(effectiveIdentity(probe, { defaults })).toEqual({ identity: 'automation', source: 'default' });
    expect(effectiveIdentity(readPlaybook, { defaults })).toEqual({
      identity: { app: 'ops-team' },
      source: 'default',
    });
    expect(effectiveIdentity(report, { defaults: { all: 'ops-team' } })).toEqual({
      identity: { app: 'ops-team' },
      source: 'default',
    });
  });

  it('never moves a write-capable job to a default (that would skip its approval)', () => {
    expect(effectiveIdentity(writePlaybook, { defaults })).toEqual({
      identity: 'automation',
      source: 'automation',
    });
  });

  it('keeps the identity the definition names over a default', () => {
    expect(effectiveIdentity(named, { defaults })).toEqual({
      identity: { app: 'intune-ops' },
      source: 'definition',
    });
  });

  it('puts the portal override first, for any job but news and content health', () => {
    const override = { app: 'audit-team' } as const;
    for (const d of [report, named, writePlaybook])
      expect(effectiveIdentity(d, { override, defaults })).toEqual({
        identity: override,
        source: 'override',
      });
    expect(effectiveIdentity(report, { override: 'automation', defaults })).toEqual({
      identity: 'automation',
      source: 'override',
    });
    expect(effectiveIdentity(news, { override, defaults })).toEqual({
      identity: 'automation',
      source: 'automation',
    });
  });
});
