import { PROBE_METRICS, ProbeCheck, type Probe } from '@adminforge/schemas';
import { brief, ENVELOPE, errors, ok } from './helpers';

const probe = (check: string, extra = '') => `${ENVELOPE('probe', 'probes.example')}check: ${check}\n${extra}`;

describe('probe', () => {
  it.each([
    '{ kind: http, url: "https://status.example.com/health", expect: { status: [200, 204], bodyContains: ok, maxLatencyMs: 2000 } }',
    '{ kind: graph, path: /organization, query: { $select: id } }',
    '{ kind: arm, path: /subscriptions, apiVersion: 2022-12-01 }',
    '{ kind: tokenAcquisition, service: graph }',
    '{ kind: tokenAcquisition, connection: integrations.hr-sync }',
    '{ kind: certExpiry, host: portal.example.com, warnDays: 21, critDays: 7 }',
    '{ kind: dnsResolve, name: example.com, type: MX, expect: { minAnswers: 1 } }',
    '{ kind: functionHealth, connection: integrations.hr-sync }',
    '{ kind: appCredentialExpiry, warnDays: 30, include: [secrets] }',
    '{ kind: licenseThreshold, sku: ENTERPRISEPACK, maxPercent: 90, critPercent: 98 }',
    '{ kind: signInHealth, window: PT1H, maxFailurePercent: 5, minSignIns: 50 }',
  ])('accepts %s', (check) => expect(ok<Probe>(probe(check, 'intervalHint: PT5M\ntimeoutMs: 10000\n')).check).toBeTruthy());
  it('applies check defaults', () =>
    expect(ok<Probe>(probe('{ kind: certExpiry, host: example.com }')).check).toEqual({ kind: 'certExpiry', host: 'example.com', port: 443, warnDays: 30, critDays: 7 }));
  it.each([
    ['an unknown check kind', '{ kind: ping, host: x }', '', 'check.kind@6', /Expected 'http' \| 'graph'/],
    ['latency thresholds where warn > crit', '{ kind: graph, path: /me }', 'thresholds: { warn: 5000, crit: 1000 }\n', 'thresholds@7', /warn must be ≤ crit/],
    ['days thresholds where warn < crit', '{ kind: certExpiry, host: example.com }', 'thresholds: { warn: 5, crit: 10 }\n', 'thresholds@7', /warn must be ≥ crit/],
    ['critDays above warnDays', '{ kind: appCredentialExpiry, warnDays: 7, critDays: 30 }', '', 'check.critDays@6', /critDays must be ≤ warnDays/],
    ['tokenAcquisition with neither target', '{ kind: tokenAcquisition }', '', 'check.service@6', /exactly one of service or connection/],
    ['a percentage above 100', '{ kind: licenseThreshold, sku: X, maxPercent: 120 }', '', 'check.maxPercent@6', /<=100/],
    ['a non-http URL', '{ kind: http, url: "ftp://example.com" }', '', 'check.url@6', /Invalid input/],
    ['a bad interval', '{ kind: graph, path: /me }', 'intervalHint: every 5 minutes\n', 'intervalHint@7', /duration/],
  ])('rejects %s', (_label, check, extra, at, message) => {
    const e = errors(probe(check, extra));
    expect(brief(e)).toEqual([at]);
    expect(e[0]!.message).toMatch(message);
  });
  it('documents the metric for every check kind', () =>
    expect(Object.keys(PROBE_METRICS).sort()).toEqual(ProbeCheck.options.map((o) => o.shape.kind.value).sort()));
});
