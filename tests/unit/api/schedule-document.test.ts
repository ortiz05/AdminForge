import type { AppError } from '@adminforge/api/src/errors';
import {
  copiedRequires,
  notifyTargets,
  reportJobDocument,
  scaffoldSchedule,
  scheduleDocument,
} from '@adminforge/api/src/schedules/scaffold';
import { parseDefinition, Schedule } from '@adminforge/schemas';

// One builder for schedule documents: the schedule editor's YAML and report schedules created in the portal.

const NOW = new Date('2026-10-15T12:00:00Z');

describe('schedule document builder', () => {
  it('builds a valid report schedule with delivery and alerts as configuration key references', () => {
    const doc = scheduleDocument({
      key: 'portal.identity-inactive-users-3f9a2c',
      version: '1.0.3',
      title: 'Inactive users, weekly',
      owner: 'avery@example.com',
      tags: ['identity', 'portal'],
      cron: '0 6 * * 1',
      timezone: 'UTC',
      enabled: true,
      job: reportJobDocument({
        ref: 'identity.inactive-users',
        format: 'csv',
        retain: 26,
        params: { days: 90 },
        emailKey: 'AF_REPORT_RECIPIENTS',
        teamsKey: 'AF_TEAMS_ALERTS_WEBHOOK',
      }),
      retries: 2,
      notifyOnFailure: notifyTargets({ emailKey: 'AF_SECURITY_ALERTS' }),
      requires: copiedRequires({ scopes: { graph: ['User.Read.All'] }, licences: ['AAD_PREMIUM'] }),
    });
    expect(Schedule.parse(doc)).toMatchObject({
      id: 'portal.identity-inactive-users-3f9a2c',
      version: '1.0.3',
      tags: ['identity', 'portal'],
      identity: 'automation',
      overlap: 'skip',
      retry: { max: 2, backoff: 'exponential', delay: '5m' },
      job: {
        kind: 'report',
        params: { days: 90 },
        delivery: [
          { type: 'file', format: 'csv', retain: 26 },
          { type: 'email', to: ['${ env.AF_REPORT_RECIPIENTS }'], format: 'csv' },
          { type: 'teams', webhook: '${ env.AF_TEAMS_ALERTS_WEBHOOK }' },
        ],
      },
      notify: { onFailure: [{ type: 'email', to: ['${ env.AF_SECURITY_ALERTS }'] }] },
      requires: { scopes: { graph: ['User.Read.All'] }, licences: ['AAD_PREMIUM'] },
    });
    expect(doc).not.toHaveProperty('$schema');
    expect(copiedRequires({ portalRoles: ['Portal.Admin'] } as never)).toBeNull();
    expect(reportJobDocument({ ref: 'a.b', format: 'xlsx', params: {} })).not.toHaveProperty('params');
  });

  it('the schedule editor produces the same document as YAML (plus $schema)', async () => {
    const r = await scaffoldSchedule(
      {
        title: 'Inactive users, weekly',
        cron: '0 6 * * 1',
        timezone: 'UTC',
        enabled: true,
        retries: 2,
        identity: 'automation',
        job: {
          kind: 'report',
          ref: 'identity.inactive-users',
          format: 'csv',
          retain: 26,
          emailEnv: 'AF_REPORT_RECIPIENTS',
        },
      },
      { known: [], now: NOW },
    );
    const parsed = parseDefinition(r.yaml, 'schedules/reports/inactive-users-weekly.schedule.yaml');
    if (!parsed.ok) throw new Error('the editor YAML is not valid');
    const built = scheduleDocument({
      $schema: '../../../packages/schemas/generated/schedule.schema.json',
      key: 'reports.inactive-users-weekly',
      title: 'Inactive users, weekly',
      owner: 'portal-admins',
      cron: '0 6 * * 1',
      timezone: 'UTC',
      enabled: true,
      job: reportJobDocument({
        ref: 'identity.inactive-users',
        format: 'csv',
        retain: 26,
        emailKey: 'AF_REPORT_RECIPIENTS',
      }),
      retries: 2,
    });
    expect(parsed.def).toEqual(Schedule.parse(built));
  });

  it('the editor refuses keys in the reserved portal. namespace', async () => {
    const err = await scaffoldSchedule(
      {
        title: 'Sneaky',
        key: 'portal.sneaky',
        cron: '0 6 * * 1',
        timezone: 'UTC',
        enabled: true,
        retries: 2,
        identity: 'automation',
        job: { kind: 'contentHealth' },
      },
      { known: [], now: NOW },
    ).catch((e: AppError) => e);
    expect(err).toMatchObject({ status: 400, code: 'invalid_request' });
    expect((err as AppError).message).toContain('reserved');
  });
});
