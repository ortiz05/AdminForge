import { parseDefinition } from '@adminforge/schemas';
import { ALL_ROLES, AVERY, FakeDefinitions, READER, schedulesApp } from './schedules-helpers';

// The schedule editor: live cron preview and schedule YAML for review (nothing is stored server-side).
const report = {
  kind: 'report' as const,
  id: 'identity.inactive-guests',
  version: '1.0.0',
  title: 'Inactive guests',
  owner: 'identity-team',
  requires: { scopes: { graph: ['User.Read.All'] }, licences: ['signInLogs'] },
};
const playbook = {
  kind: 'playbook' as const,
  id: 'identity.disable-user',
  version: '1.0.0',
  title: 'Disable',
  mode: 'write',
  steps: [],
};

async function setup() {
  const t = await schedulesApp({ defs: new FakeDefinitions().set(report).set(playbook) });
  const user = await t.login(READER, ['Portal.Reader']);
  return { t, user };
}

describe('schedule editor API', () => {
  it('previews a cron expression in plain language with the next runs', async () => {
    const { t, user } = await setup();
    const ok = (
      await user.post('/api/schedules/preview', { cron: '15 6 * * 1', timezone: 'Europe/London' })
    ).json();
    expect(ok.valid).toBe(true);
    expect(ok.text).toMatch(/Monday/);
    expect(ok.next).toHaveLength(5);
    const bad = (await user.post('/api/schedules/preview', { cron: '61 * * * *', timezone: 'UTC' })).json();
    expect(bad).toMatchObject({ valid: false, next: [] });
    expect(bad.problem).toBeTruthy();
    await t.close();
  });

  it('scaffolds a report schedule: env-key recipients, copied requirements, valid YAML and a path', async () => {
    const { t, user } = await setup();
    const res = await user.post('/api/schedules/scaffold', {
      title: 'Weekly inactive guests',
      cron: '15 6 * * 1',
      timezone: 'UTC',
      job: {
        kind: 'report',
        ref: 'identity.inactive-guests',
        format: 'xlsx',
        retain: 26,
        emailEnv: 'AF_REPORT_RECIPIENTS',
      },
      notifyOnFailure: { teamsWebhookEnv: 'AF_TEAMS_ALERTS_WEBHOOK' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe('portal/content/schedules/reports/weekly-inactive-guests.schedule.yaml');
    const parsed = parseDefinition(body.yaml, 'schedules/reports/weekly-inactive-guests.schedule.yaml');
    if (!parsed.ok) throw new Error('scaffold did not validate');
    const doc = parsed.def;
    expect(doc).toMatchObject({
      kind: 'schedule',
      id: 'reports.weekly-inactive-guests',
      identity: 'automation',
      job: {
        kind: 'report',
        delivery: [
          { type: 'file', format: 'xlsx', retain: 26 },
          { type: 'email', to: ['${ env.AF_REPORT_RECIPIENTS }'] },
        ],
      },
      notify: { onFailure: [{ type: 'teams', webhook: '${ env.AF_TEAMS_ALERTS_WEBHOOK }' }] },
      requires: { scopes: { graph: ['User.Read.All'] }, licences: ['signInLogs'] },
    });
    expect(body.yaml).toMatch(/^# Made with the schedule editor/);
    await t.close();
  });

  it('a write playbook needs a reviewer, and tenant values never land in YAML', async () => {
    const { t, user } = await setup();
    const write = await user.post('/api/schedules/scaffold', {
      title: 'Disable stale',
      cron: '0 3 * * *',
      timezone: 'UTC',
      job: { kind: 'playbook', ref: 'identity.disable-user', mode: 'write' },
    });
    expect(write.json().error.code).toBe('review_required');
    const guid = await user.post('/api/schedules/scaffold', {
      title: 'Check 11111111-2222-4333-8444-555555555555',
      cron: '0 3 * * *',
      timezone: 'UTC',
      job: { kind: 'contentHealth' },
    });
    expect(guid.json().error.code).toBe('tenant_value_in_query');
    const missing = await user.post('/api/schedules/scaffold', {
      title: 'Nope',
      cron: '0 3 * * *',
      timezone: 'UTC',
      job: { kind: 'report', ref: 'identity.nope' },
    });
    expect(missing.statusCode).toBe(404);
    await t.close();
  });

  it('needs a portal role', async () => {
    const { t } = await setup();
    const op = await t.login(AVERY, ALL_ROLES);
    expect((await op.post('/api/schedules/preview', { cron: '0 * * * *', timezone: 'UTC' })).statusCode).toBe(
      200,
    );
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/schedules/preview', payload: {} })).statusCode,
    ).toBe(401);
    await t.close();
  });
});
