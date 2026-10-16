import {
  deliveryKeyLabel,
  deliveryOptions,
  deliveryView,
  envRefKey,
} from '@adminforge/api/src/schedules/delivery-keys';
import { AppError } from '@adminforge/api/src/errors';
import { assertDelivery, bumpPatch, portalScheduleKey } from '@adminforge/api/src/schedules/portal';
import { Schedule } from '@adminforge/schemas';

// Delivery by configuration key name: labels, the options the schedule form offers, the checks on a request, and the
// key-only view of a schedule's delivery (values never leave the server).

const ENV = {
  AF_MAIL_SENDER: 'reports@example.com',
  AF_REPORT_RECIPIENTS: 'it@example.com',
  AF_SECURITY_ALERTS: 'secops@example.com',
  AF_OWNER_EMAIL: 'owner@example.com',
  AF_TEAMS_ALERTS_WEBHOOK: 'https://example.webhook.office.com/synthetic',
  AF_WEBHOOK_REPORTS: 'https://example.webhook.office.com/synthetic-2',
  AF_EMPTY_RECIPIENTS: '  ',
  AF_TENANT_ID: '11111111-2222-4333-8444-555555555555',
};

describe('deliveryKeyLabel', () => {
  it.each([
    ['AF_REPORT_RECIPIENTS', 'Report recipients'],
    ['AF_TEAMS_ALERTS_WEBHOOK', 'Teams alerts'],
    ['AF_SECURITY_ALERTS', 'Security alerts'],
    ['AF_OWNER_EMAIL', 'Owner email'],
    ['AF_WEBHOOK_REPORTS', 'Webhook reports'],
  ])('%s → %s', (key, label) => expect(deliveryKeyLabel(key)).toBe(label));
});

describe('deliveryOptions', () => {
  it('lists configured (non-empty) recipient lists and webhooks by name only', () => {
    const o = deliveryOptions(ENV);
    expect(o).toEqual({
      email: {
        available: true,
        lists: [
          { key: 'AF_OWNER_EMAIL', label: 'Owner email' },
          { key: 'AF_REPORT_RECIPIENTS', label: 'Report recipients' },
          { key: 'AF_SECURITY_ALERTS', label: 'Security alerts' },
        ],
      },
      teams: {
        lists: [
          { key: 'AF_TEAMS_ALERTS_WEBHOOK', label: 'Teams alerts' },
          { key: 'AF_WEBHOOK_REPORTS', label: 'Webhook reports' },
        ],
      },
    });
    expect(JSON.stringify(o)).not.toMatch(/@|https:|1111/);
  });
  it('email is unavailable without the sender mailbox', () => {
    expect(deliveryOptions({ AF_REPORT_RECIPIENTS: 'it@example.com' }).email.available).toBe(false);
    expect(deliveryOptions({}).email).toEqual({ available: false, lists: [] });
  });
});

describe('assertDelivery', () => {
  const job = { kind: 'report' as const, ref: 'identity.x', format: 'xlsx' as const, retain: 26 };
  const code = (fn: () => void) => {
    try {
      fn();
      return 'ok';
    } catch (err) {
      return (err as AppError).code;
    }
  };
  it('accepts configured keys and no delivery at all', () => {
    expect(code(() => assertDelivery(ENV, { job }))).toBe('ok');
    expect(
      code(() =>
        assertDelivery(ENV, {
          job: { ...job, emailKey: 'AF_REPORT_RECIPIENTS', teamsKey: 'AF_TEAMS_ALERTS_WEBHOOK' },
          notifyOnFailure: { emailKey: 'AF_SECURITY_ALERTS', teamsKey: 'AF_WEBHOOK_REPORTS' },
        }),
      ),
    ).toBe('ok');
  });
  it.each([
    ['an empty list', { job: { ...job, emailKey: 'AF_EMPTY_RECIPIENTS' } }],
    ['a missing list', { job: { ...job, emailKey: 'AF_NOPE_RECIPIENTS' } }],
    ['a key that is not a recipient list', { job: { ...job, emailKey: 'AF_TENANT_ID' } }],
    ['a list as a webhook', { job: { ...job, teamsKey: 'AF_REPORT_RECIPIENTS' } }],
    ['a missing failure webhook', { job, notifyOnFailure: { teamsKey: 'AF_OPS_WEBHOOK' } }],
    ['a missing failure list', { job, notifyOnFailure: { emailKey: 'AF_OPS_ALERTS' } }],
  ])('refuses %s (delivery_not_configured)', (_label, b) =>
    expect(code(() => assertDelivery(ENV, b))).toBe('delivery_not_configured'),
  );
  it('email needs the sender; Teams does not', () => {
    const noSender = {
      AF_REPORT_RECIPIENTS: 'it@example.com',
      AF_TEAMS_ALERTS_WEBHOOK: 'https://x.webhook.office.com/y',
    };
    expect(code(() => assertDelivery(noSender, { job: { ...job, emailKey: 'AF_REPORT_RECIPIENTS' } }))).toBe(
      'delivery_not_configured',
    );
    expect(
      code(() => assertDelivery(noSender, { job: { ...job, teamsKey: 'AF_TEAMS_ALERTS_WEBHOOK' } })),
    ).toBe('ok');
  });
});

describe('deliveryView', () => {
  it('shows a report schedule’s targets and failure alerts by key name', () => {
    const def = Schedule.parse({
      kind: 'schedule',
      id: 'reports.x',
      version: '1.0.0',
      title: 'X',
      owner: 'team',
      cron: '0 6 * * 1',
      job: {
        kind: 'report',
        ref: 'identity.x',
        delivery: [
          { type: 'file', format: 'csv' },
          { type: 'email', to: ['${ env.AF_REPORT_RECIPIENTS }', '${ env.AF_OWNER_EMAIL }'] },
          { type: 'teams', webhook: '${ env.AF_TEAMS_ALERTS_WEBHOOK }' },
          { type: 'teams', team: 'Ops', channel: 'General' },
        ],
      },
      notify: { onFailure: [{ type: 'email', to: ['${ env.AF_SECURITY_ALERTS }'] }] },
    });
    expect(deliveryView(def)).toEqual({
      delivery: [
        { type: 'file', format: 'csv', retain: null },
        { type: 'email', key: 'AF_REPORT_RECIPIENTS', label: 'Report recipients', format: 'xlsx' },
        { type: 'email', key: 'AF_OWNER_EMAIL', label: 'Owner email', format: 'xlsx' },
        { type: 'teams', key: 'AF_TEAMS_ALERTS_WEBHOOK', label: 'Teams alerts' },
      ],
      notify: [{ type: 'email', key: 'AF_SECURITY_ALERTS', label: 'Security alerts' }],
    });
  });
  it('other jobs have no delivery; no failure alerts → no notify', () => {
    const def = Schedule.parse({
      kind: 'schedule',
      id: 'probes.x',
      version: '1.0.0',
      title: 'X',
      owner: 'team',
      cron: '0 * * * *',
      job: { kind: 'probe', ref: 'probes.y' },
    });
    expect(deliveryView(def)).toEqual({});
  });
  it('envRefKey reads only whole ${ env.KEY } references', () => {
    expect(envRefKey('${ env.AF_X_RECIPIENTS }')).toBe('AF_X_RECIPIENTS');
    expect(envRefKey('ops@example.com')).toBeNull();
    expect(envRefKey(undefined)).toBeNull();
  });
});

describe('portal schedule keys and versions', () => {
  it('keys live in the reserved portal. namespace, one per report and random suffix', () => {
    expect(portalScheduleKey('identity.inactive-users', '3f9a2c')).toBe(
      'portal.identity-inactive-users-3f9a2c',
    );
  });
  it.each([
    ['1.0.0', '1.0.1'],
    ['1.2.9', '1.2.10'],
    ['2.0.0-beta.1', '2.0.1'],
  ])('bumpPatch(%s) = %s', (v, next) => expect(bumpPatch(v)).toBe(next));
});
