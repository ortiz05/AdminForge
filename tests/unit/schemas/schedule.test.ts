import { isValidTimeZone, validateCron, type Schedule } from '@adminforge/schemas';
import { brief, ENVELOPE, errors, ok } from './helpers';

const base = `${ENVELOPE('schedule', 'reports.example')}cron: "0 7 * * 1"\n`;
const reportJob =
  'job:\n  kind: report\n  ref: identity.app-credential-expiry\n  params: { days: 30 }\n  delivery:\n    - { type: file, format: xlsx, path: "creds/{date}.xlsx", retain: 4 }\n';

describe('cron', () => {
  it.each([
    '0 7 * * 1',
    '*/15 * * * *',
    '0 0 1 JAN,JUL ?',
    '30 2 * * MON-FRI',
    '0 9 L * *',
    '0 9 * * 5L',
    '0 9 * * MON#1',
    '0 0 7 * * 1',
    '0-30/10 8-18 1-15 * 0,6',
    '@daily',
    '@weekly',
    '0 0 * * 7',
  ])('accepts %s', (expr) => expect(validateCron(expr)).toBeUndefined());
  it.each([
    ['0 7 * *', /Expected 5 or 6 cron fields, got 4/],
    ['60 * * * *', /minute "60" is out of range 0-59/],
    ['0 24 * * *', /hour "24" is out of range 0-23/],
    ['0 0 0 * *', /day of month "0" is out of range 1-31/],
    ['0 0 * 13 *', /month "13"/],
    ['0 0 * * 8', /day of week "8"/],
    ['0 0 * FOO *', /month "FOO"/],
    ['*/0 * * * *', /invalid step/],
    ['0 18-8 * * *', /reversed/],
    ['0 0 1,,2 * *', /empty list item/],
    ['? * * * *', /minute "\?"/],
    ['@fortnightly', /Expected 5 or 6/],
  ])('rejects %s', (expr, message) => expect(validateCron(expr)).toMatch(message));
});

describe('time zones', () => {
  it.each(['UTC', 'Europe/London', 'America/New_York', 'America/Argentina/Buenos_Aires', 'Etc/UTC'])(
    'accepts %s',
    (tz) => expect(isValidTimeZone(tz)).toBe(true),
  );
  it.each(['Mars/Olympus', 'London', '+01:00', 'EST5EDT6', ''])('rejects %s', (tz) =>
    expect(isValidTimeZone(tz)).toBe(false),
  );
});

describe('schedule', () => {
  it('accepts a report schedule and applies defaults', () => {
    const def = ok<Schedule>(base + reportJob);
    expect(def).toMatchObject({ timezone: 'UTC', enabled: true, identity: 'automation', overlap: 'skip' });
    expect(def.job.kind === 'report' && def.job.delivery[0]).toEqual({
      type: 'file',
      format: 'xlsx',
      path: 'creds/{date}.xlsx',
      retain: 4,
    });
  });
  it('accepts every job kind', () => {
    for (const job of [
      'job: { kind: playbook, ref: identity.disable-user, mode: write, approvedBy: [approval-0001], inputs: { userId: x } }',
      'job: { kind: probe, ref: probes.graph-reachability }',
      `job: { kind: script, script: exchange/Get-Thing.ps1, sha256: ${'f'.repeat(64)}, services: [exchange] }`,
      'job: { kind: contentHealth, scopes: true }',
    ])
      expect(
        ok(`${base}timezone: Europe/London\nretry: { max: 2, delay: 5m }\ntimeoutSeconds: 600\n${job}\n`),
      ).toBeTruthy();
  });
  it('accepts email and Teams delivery and failure notifications', () =>
    expect(
      ok<Schedule>(
        `${base}job:\n  kind: report\n  ref: identity.x\n  delivery:\n    - { type: email, to: ["\${ env.AF_REPORT_RECIPIENTS }"], subject: Weekly }\n    - { type: teams, webhook: "\${ env.AF_TEAMS_WEBHOOK }" }\nnotify:\n  onFailure: [{ type: teams, team: Ops, channel: Alerts }]\n`,
      ).job,
    ).toMatchObject({ delivery: [{ type: 'email', format: 'xlsx', attach: true }, { type: 'teams' }] }));
  it.each([
    ['an invalid cron', base.replace('0 7 * * 1', '0 7 * *') + reportJob, 'cron@6', /5 or 6 cron fields/],
    ['an unknown time zone', `${base}timezone: Mars/Olympus\n${reportJob}`, 'timezone@7', /IANA time zone/],
    [
      'a write playbook without approvedBy',
      `${base}job: { kind: playbook, ref: identity.x, mode: write }\n`,
      'job.approvedBy@7',
      /two-person/,
    ],
    [
      'a write script without approvedBy',
      `${base}job: { kind: script, script: a.ps1, sha256: ${'f'.repeat(64)}, mode: write }\n`,
      'job.approvedBy@7',
      /two-person/,
    ],
    [
      'a literal Teams webhook URL',
      `${base}job: { kind: report, ref: identity.x, delivery: [{ type: teams, webhook: "https://example.com/hook" }] }\n`,
      'job.delivery[0].webhook@7',
      /single \$\{/,
    ],
    [
      'an absolute file path',
      `${base}job: { kind: report, ref: identity.x, delivery: [{ type: file, path: /etc/x }] }\n`,
      'job.delivery[0].path@7',
      /relative path/,
    ],
    [
      'a report without delivery',
      `${base}job: { kind: report, ref: identity.x, delivery: [] }\n`,
      'job.delivery@7',
      />=1/,
    ],
    [
      'an unknown job kind',
      `${base}job: { kind: backup }\n`,
      'job.kind@7',
      /Expected 'report' \| 'playbook'/,
    ],
    ['a delegated identity', `${base}identity: delegated\n${reportJob}`, 'identity@7', /automation/],
    ['a 5-hour timeout', `${base}timeoutSeconds: 18000\n${reportJob}`, 'timeoutSeconds@7', /<=14400/],
  ])('rejects %s', (_label, text, at, message) => {
    const e = errors(text);
    expect(brief(e)).toEqual([at]);
    expect(e[0]!.message).toMatch(message);
  });
});
