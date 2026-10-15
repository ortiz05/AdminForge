import { KqlCheck, PROBE_METRICS, validateReferences, type Probe, type Schedule } from '@adminforge/schemas';
import { brief, ENVELOPE, errors, ok } from './helpers';

const probe = (check: string, extra = '') => `${ENVELOPE('probe', 'probes.example')}check:\n${check}${extra}`;

describe('kql probe check', () => {
  it('accepts a Resource Graph check and applies defaults', () => {
    const def = ok<Probe>(probe('  kind: kql\n  source: resourceGraph\n  query: resources | where type =~ "microsoft.storage/storageaccounts"\n'));
    expect(def.check).toEqual({ kind: 'kql', source: 'resourceGraph', query: 'resources | where type =~ "microsoft.storage/storageaccounts"', metric: 'rowCount', detailsLimit: 50 });
  });
  it.each([
    ['resourceGraph with subscriptions', '  kind: kql\n  source: resourceGraph\n  query: resources\n  subscriptions: ["${ env.AF_SUBSCRIPTION_ID }"]\n'],
    ['resourceGraph with an expression list', '  kind: kql\n  source: resourceGraph\n  query: resources\n  managementGroups: "${ [env.AF_MG] }"\n'],
    ['logAnalytics with workspace and timespan', '  kind: kql\n  source: logAnalytics\n  query: AzureActivity | take 1\n  workspace: "${ env.AF_LOG_ANALYTICS_WORKSPACE_ID }"\n  timespan: PT1H\n'],
    ['advancedHunting with a column metric', '  kind: kql\n  source: advancedHunting\n  query: DeviceInfo | summarize n = count()\n  timespan: P1D\n  metric: { column: n, aggregate: max }\n  detailsLimit: 0\n'],
    ['a query with env expressions', '  kind: kql\n  source: resourceGraph\n  query: "resources | where tags.env == ${ $kql(env.AF_ENV_LABEL) }"\n'],
  ])('accepts %s', (_label, check) => expect(ok<Probe>(probe(check, 'thresholds: { warn: 1, crit: 5 }\n')).check.kind).toBe('kql'));
  it('defaults the column aggregate to first', () =>
    expect(ok<Probe>(probe('  kind: kql\n  source: logAnalytics\n  query: T\n  metric: { column: failures }\n')).check).toMatchObject({ metric: { column: 'failures', aggregate: 'first' } }));
  it.each([
    ['subscriptions on Log Analytics', '  kind: kql\n  source: logAnalytics\n  query: T\n  subscriptions: [a]\n', 'check.subscriptions@6', /applies to source resourceGraph/],
    ['a workspace on Resource Graph', '  kind: kql\n  source: resourceGraph\n  query: resources\n  workspace: x\n', 'check.workspace@6', /applies to source logAnalytics/],
    ['a timespan on Resource Graph', '  kind: kql\n  source: resourceGraph\n  query: resources\n  timespan: P1D\n', 'check.timespan@6', /applies to source logAnalytics or advancedHunting/],
    ['subscriptions and management groups together', '  kind: kql\n  source: resourceGraph\n  query: resources\n  subscriptions: [a]\n  managementGroups: [b]\n', 'check.managementGroups@6', /not both/],
    ['a shorthand timespan', '  kind: kql\n  source: logAnalytics\n  query: T\n  timespan: 1h\n', 'check.timespan@11', /Invalid input|ISO 8601/],
    ['an unknown source', '  kind: kql\n  source: sentinel\n  query: T\n', 'check.source@8', /Invalid option|Expected/],
    ['an unknown aggregate', '  kind: kql\n  source: logAnalytics\n  query: T\n  metric: { column: n, aggregate: median }\n', 'check.metric@10', /Invalid input|Expected/],
    ['too many detail rows', '  kind: kql\n  source: logAnalytics\n  query: T\n  detailsLimit: 1000\n', 'check.detailsLimit@10', /<=500/],
  ])('rejects %s', (_label, check, at, message) => {
    const e = errors(probe(check));
    expect(e.map((x) => x.message).join(' | ')).toMatch(message);
    expect(brief(e)[0]!.split('@')[0]).toBe(at.split('@')[0]);
  });
  it('treats more rows as worse', () => expect(PROBE_METRICS.kql).toEqual({ metric: 'rows', unit: 'rows', worse: 'higher' }));
  it('validates warn ≤ crit for KQL thresholds', () =>
    expect(errors(probe('  kind: kql\n  source: resourceGraph\n  query: resources\n', 'thresholds: { warn: 10, crit: 1 }\n'))[0]!.message).toMatch(/warn must be ≤ crit/));
  it('exposes the check schema', () => expect(KqlCheck.shape.kind.value).toBe('kql'));
});

describe('licence threshold sku', () => {
  it('accepts a part number or a whole ${ env.X } expression', () => {
    expect(ok<Probe>(probe('  kind: licenseThreshold\n  sku: SPE_E3\n  maxPercent: 90\n')).check).toMatchObject({ sku: 'SPE_E3' });
    expect(ok<Probe>(probe('  kind: licenseThreshold\n  sku: "${ env.AF_LICENCE_SKU }"\n  maxPercent: 90\n')).check).toMatchObject({ sku: '${ env.AF_LICENCE_SKU }' });
  });
  it('rejects free text that is neither', () => expect(errors(probe('  kind: licenseThreshold\n  sku: "E3 ${ env.X }"\n  maxPercent: 90\n'))[0]!.path).toBe('check.sku'));
});

describe('probe jobs', () => {
  const base = `${ENVELOPE('schedule', 'sweep.example')}cron: "*/15 * * * *"\n`;
  it.each([
    ['ref', 'job: { kind: probe, ref: probes.graph-reachability }'],
    ['refs', 'job: { kind: probe, refs: [probes.a, probes.b], concurrency: 2 }'],
    ['select', 'job: { kind: probe, select: { tags: [sweep-15m] } }'],
  ])('accepts %s', (_label, job) => expect(ok<Schedule>(`${base}${job}\n`).job.kind).toBe('probe'));
  it.each([
    ['none of them', 'job: { kind: probe }'],
    ['ref and select', 'job: { kind: probe, ref: probes.a, select: { tags: [x] } }'],
    ['refs and ref', 'job: { kind: probe, ref: probes.a, refs: [probes.b] }'],
  ])('rejects %s', (_label, job) => expect(errors(`${base}${job}\n`)[0]!.message).toMatch(/exactly one of ref, refs or select/));
  it('rejects an empty tag list and an empty refs list', () => {
    expect(errors(`${base}job: { kind: probe, select: { tags: [] } }\n`)[0]!.path).toBe('job.select.tags');
    expect(errors(`${base}job: { kind: probe, refs: [] }\n`)[0]!.path).toBe('job.refs');
  });

  it('checks refs and tag selectors against the probes that exist', () => {
    const p = (id: string, tags: string[]) => ({ file: `${id}.probe.yaml`, def: ok<Probe>(`${ENVELOPE('probe', id)}tags: [${tags.join(', ')}]\ncheck: { kind: graph, path: /organization }\n`) });
    const s = (id: string, job: string) => ({ file: `${id}.schedule.yaml`, def: ok<Schedule>(`${ENVELOPE('schedule', id)}cron: "@hourly"\n${job}\n`) });
    const found = validateReferences([
      p('probes.a', ['sweep-1h', 'dns']),
      p('probes.b', ['sweep-1h']),
      s('sweep.ok', 'job: { kind: probe, select: { tags: [sweep-1h, dns] } }'),
      s('sweep.none', 'job: { kind: probe, select: { tags: [sweep-1h, tls] } }'),
      s('sweep.refs', 'job: { kind: probe, refs: [probes.a, probes.missing] }'),
    ]).map((e) => `${e.file} ${e.path}: ${e.message}`);
    expect(found).toEqual(['sweep.none.schedule.yaml job.select.tags: No probe has all of the tags sweep-1h, tls.', 'sweep.refs.schedule.yaml job.refs[1]: Unknown probe "probes.missing".']);
  });
});

