import {
  facetCounts,
  failingSchedules,
  hourlyBuckets,
  hourRanges,
  listParam,
  passRates,
  probeFunction,
  probeMatches,
  rowSummary,
  scheduleFunction,
  scheduleHealth,
  scheduleMatches,
  scheduleServices,
  type MonitoringFilters,
} from '@adminforge/web/src/ops/monitoring-model';
import type { ProbeItem, ScheduleItem } from '@adminforge/web/src/ops/schedules';

// Monitoring (Overview › Monitoring): one set of filters — service, function, tag, problems, text — over health checks
// and schedules; a probe sweep belongs to the services of the probes it runs; the last 24 hours bucketed by hour.
const NOW = Date.parse('2026-10-23T12:30:00Z');
const probe = (key: string, o: Partial<ProbeItem> = {}): ProbeItem => ({
  key,
  title: key,
  kind: 'http',
  group: null,
  summary: null,
  remedy: null,
  link: null,
  tags: [],
  latest: null,
  series: [],
  thresholds: { warn: null, crit: null, unit: 'ms', worse: 'higher' },
  ...o,
});
const point = (ago: number, status: 'ok' | 'warn' | 'crit') => ({
  ts: new Date(NOW - ago).toISOString(),
  metric: 1,
  status,
  message: null,
});
const schedule = (key: string, o: Partial<ScheduleItem> = {}): ScheduleItem =>
  ({
    key,
    title: key,
    summary: null,
    cron: '0 7 * * 1',
    cronText: null,
    timezone: 'UTC',
    enabled: true,
    identity: 'automation',
    runsAs: { kind: 'automation', name: null, label: 'automation identity' },
    job: { kind: 'report', ref: 'identity.x', params: null },
    group: 'identity',
    tags: [],
    covers: null,
    nextRunAt: null,
    lastRunAt: '2026-10-22T07:00:00Z',
    lastStatus: 'succeeded',
    writeCapable: false,
    approvedBy: [],
    source: 'content',
    pendingApprovalId: null,
    createdBy: null,
    canManage: false,
    delivery: [],
    notify: [],
    ...o,
  }) as ScheduleItem;
const none: MonitoringFilters = { services: [], functions: [], tags: [], text: '', problems: false };

const mail = probe('probes.mail', {
  kind: 'mailFlow',
  group: 'exchange',
  tags: ['synthetic', 'sweep-15m'],
  latest: { ...point(60_000, 'crit'), unit: 's', message: 'No delivery within 90 s' },
});
const dns = probe('probes.dns', { kind: 'dnsResolve', group: 'exchange', tags: ['sweep-15m'] });
const cert = probe('probes.cert', { kind: 'certExpiry', group: 'platform', tags: ['sweep-6h'] });
const probes = [mail, dns, cert];

describe('Monitoring filters', () => {
  it('sorts every item into a function', () => {
    expect([mail, dns, cert].map(probeFunction)).toEqual(['transactions', 'availability', 'expiry']);
    expect(
      ['report', 'playbook', 'script', 'probe', 'contentHealth', 'news'].map((kind) =>
        scheduleFunction(schedule('s', { job: { kind, ref: null, params: null } })),
      ),
    ).toEqual(['reports', 'automations', 'automations', 'sweeps', 'maintenance', 'maintenance']);
  });

  it('narrows checks by service, function, any of the tags, problems and text', () => {
    const keys = (f: Partial<MonitoringFilters>) =>
      probes.filter((p) => probeMatches(p, { ...none, ...f })).map((p) => p.key);
    expect(keys({ services: ['exchange'] })).toEqual(['probes.mail', 'probes.dns']);
    expect(keys({ functions: ['expiry', 'transactions'] })).toEqual(['probes.mail', 'probes.cert']);
    expect(keys({ tags: ['sweep-6h', 'synthetic'] })).toEqual(['probes.mail', 'probes.cert']);
    expect(keys({ problems: true })).toEqual(['probes.mail']);
    expect(keys({ text: 'within 90' })).toEqual(['probes.mail']);
    expect(keys({ services: ['exchange'], functions: ['availability'] })).toEqual(['probes.dns']);
  });

  it('puts a probe sweep in the services of the probes it runs', () => {
    const sweep = schedule('sweep', {
      job: { kind: 'probe', ref: null, params: null },
      group: null,
      covers: { tags: ['sweep-15m'] },
    });
    const one = schedule('one', {
      job: { kind: 'probe', ref: 'probes.cert', params: null },
      group: null,
      covers: { refs: ['probes.cert'] },
    });
    expect(scheduleServices(sweep, probes)).toEqual(['exchange']);
    expect(scheduleServices(one, probes)).toEqual(['platform']);
    expect(scheduleMatches(sweep, { ...none, services: ['exchange'] }, probes)).toBe(true);
    expect(scheduleMatches(sweep, { ...none, services: ['identity'] }, probes)).toBe(false);
  });

  it('says how a schedule is doing, and counts only failing ones that are on', () => {
    const failed = schedule('failed', { lastStatus: 'failed' });
    const off = schedule('off', { enabled: false, lastStatus: 'failed' });
    const waiting = schedule('waiting', { enabled: false, pendingApprovalId: 'a-1' });
    const fresh = schedule('fresh', { lastRunAt: null, lastStatus: null });
    expect([failed, off, waiting, fresh].map((s) => scheduleHealth(s).label)).toEqual([
      'Failed',
      'Off',
      'Awaiting approval',
      'Not run yet',
    ]);
    expect(failingSchedules([failed, off, waiting, fresh]).map((s) => s.key)).toEqual(['failed']);
    expect(scheduleMatches(off, { ...none, problems: true }, probes)).toBe(false);
    expect(scheduleMatches(failed, { ...none, problems: true }, probes)).toBe(true);
  });

  it('counts the options each facet offers', () => {
    const { services, functions, tags } = facetCounts(probes, [schedule('r', { tags: ['weekly'] })]);
    expect(Object.fromEntries(services)).toEqual({ exchange: 2, platform: 1, identity: 1 });
    expect(functions.get('reports')).toBe(1);
    expect(tags.get('sweep-15m')).toBe(2);
  });

  it('keeps only safe list values from the URL', () => {
    expect(listParam('exchange,teams,exchange')).toBe('exchange,teams');
    expect(listParam('exchange,<script>,')).toBe('exchange');
    expect(listParam('')).toBeUndefined();
    expect(listParam(['exchange'])).toBeUndefined();
  });
});

describe('the last 24 hours', () => {
  it('counts results per hour with the worst, and the share that passed', () => {
    const p = probe('p', {
      series: [
        point(10 * 60_000, 'ok'),
        point(20 * 60_000, 'crit'),
        point(2 * 3_600_000, 'warn'),
        point(30 * 3_600_000, 'crit'),
      ],
    });
    const buckets = hourlyBuckets([p], NOW);
    expect(buckets).toHaveLength(24);
    expect(buckets.at(-1)).toMatchObject({ ok: 1, crit: 1, worst: 'crit' });
    expect(buckets.at(-3)).toMatchObject({ warn: 1, worst: 'warn' });
    expect(buckets.reduce((n, b) => n + b.ok + b.warn + b.crit, 0)).toBe(3);
    const rates = passRates(buckets);
    expect(rates.at(-1)).toBe(50);
    expect(rates.at(-3)).toBe(0);
    expect(rates[0]).toBeNull();
  });
});

describe('a timeline row in words', () => {
  it('names the hours that failed, degraded or had no results', () => {
    const p = probe('p', {
      series: [
        point(10 * 60_000, 'crit'),
        point(2 * 3_600_000, 'warn'),
        point(3 * 3_600_000, 'warn'),
        point(4 * 3_600_000, 'ok'),
      ],
    });
    const buckets = hourlyBuckets([p], NOW);
    expect(hourRanges(buckets, 'crit')).toEqual(['12:00–13:00']);
    expect(hourRanges(buckets, 'warn')).toEqual(['09:00–11:00']);
    expect(rowSummary(buckets)).toBe(
      'failing 12:00–13:00; degraded 09:00–11:00; no results 13:00–08:00, 11:00–12:00 (UTC)',
    );
    expect(rowSummary(hourlyBuckets([probe('none')], NOW))).toBe('no results in the last 24 hours');
  });
});
