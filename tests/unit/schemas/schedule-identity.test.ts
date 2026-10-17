import { identityEnvPrefix, identityKey, identityLabel, type Schedule } from '@adminforge/schemas';
import { ENVELOPE, errors, ok } from './helpers';

// Who a schedule runs as (ADR-014): the automation identity (default), a named app identity, or — for read-only
// schedules created in the portal — their creator.

const report = 'job:\n  kind: report\n  ref: identity.inactive-users\n  delivery: [{ type: file }]\n';
const probe = 'job:\n  kind: probe\n  select: { tags: [sweep-15m] }\n';
const playbook = 'job:\n  kind: playbook\n  ref: identity.disable-user\n  mode: read\n';
const news = 'job:\n  kind: news\n';
const cron = 'cron: "0 7 * * 1"\n';

describe('schedule identity', () => {
  it('defaults to the automation identity', () => {
    expect(ok<Schedule>(`${ENVELOPE('schedule', 'reports.x')}${cron}${report}`).identity).toBe('automation');
  });

  it('accepts a named app identity for any job that can run unattended', () => {
    for (const job of [report, probe, playbook]) {
      const def = ok<Schedule>(
        `${ENVELOPE('schedule', 'reports.x')}${cron}identity: { app: reports-team }\n${job}`,
      );
      expect(def.identity).toEqual({ app: 'reports-team' });
    }
  });

  it('refuses identity names that could clash with configuration or the default', () => {
    for (const bad of ['Reports', 'r', 'reports_team', 'automation', '-x']) {
      const e = errors(`${ENVELOPE('schedule', 'reports.x')}${cron}identity: { app: "${bad}" }\n${report}`);
      expect(e.map((x) => x.path).some((p) => p.startsWith('identity'))).toBe(true);
    }
  });

  it('runs as the creator only for reports and probes made in the portal', () => {
    const def = ok<Schedule>(
      `${ENVELOPE('schedule', 'portal.x')}${cron}identity: { user: creator }\n${report}`,
    );
    expect(def.identity).toEqual({ user: 'creator' });
    ok(`${ENVELOPE('schedule', 'portal.y')}${cron}identity: { user: creator }\n${probe}`);
  });

  it('refuses the creator for jobs that can change data, and for content schedules', () => {
    const writes = errors(
      `${ENVELOPE('schedule', 'portal.x')}${cron}identity: { user: creator }\n${playbook}`,
    );
    expect(writes).toEqual([
      expect.objectContaining({
        path: 'identity',
        message: expect.stringMatching(/only reports and probes/),
      }),
    ]);
    const content = errors(
      `${ENVELOPE('schedule', 'reports.x')}${cron}identity: { user: creator }\n${report}`,
    );
    expect(content).toEqual([
      expect.objectContaining({ path: 'identity', message: expect.stringMatching(/created in the portal/) }),
    ]);
  });

  it('keeps housekeeping on the automation identity', () => {
    const e = errors(`${ENVELOPE('schedule', 'news.x')}${cron}identity: { app: reports-team }\n${news}`);
    expect(e).toEqual([
      expect.objectContaining({
        path: 'identity',
        message: expect.stringMatching(/always run as the automation identity/),
      }),
    ]);
  });

  it('names identities the same way everywhere', () => {
    expect(identityKey(undefined)).toBe('automation');
    expect(identityKey('automation')).toBe('automation');
    expect(identityKey({ app: 'reports-team' })).toBe('app:reports-team');
    expect(identityKey({ user: 'creator' })).toBe('user');
    expect(identityLabel({ app: 'reports-team' })).toBe('app identity reports-team');
    expect(identityLabel({ user: 'creator' }, 'avery@example.com')).toBe(
      'avery@example.com (their own access)',
    );
    expect(identityEnvPrefix('reports-team')).toBe('AF_IDENTITY_REPORTS_TEAM_');
  });
});
