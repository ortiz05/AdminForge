import {
  DeliveryOptionsResponse,
  formValuesFromSchedule,
  identityFor,
  runAsOptions,
  scheduleRequest,
} from '@adminforge/web/src/reports/catalog';
import {
  readSchedule,
  runsAsPhrase,
  runsAsShort,
  runsAsSentence,
  signInView,
} from '@adminforge/web/src/ops/schedules';
import { DEFAULT_CRON_PARTS } from '@adminforge/web/src/ops/cadence';
import { creatorSchedule } from '../../support/web/fixtures/automation';

// Who a schedule runs as, in the web client (ADR-014): reading it, saying it, and the "Run as" choices.

describe('run as: reading and wording', () => {
  it('reads the three kinds; an older API without runsAs means the automation identity', () => {
    expect(readSchedule({ key: 'a.b', cron: '0 6 * * 1' })!.runsAs).toMatchObject({
      kind: 'automation',
      signIn: null,
    });
    const app = readSchedule({
      key: 'a.b',
      cron: '0 6 * * 1',
      identity: 'app:reports-team',
      runsAs: { kind: 'app', name: 'reports-team', label: 'app identity reports-team' },
    })!;
    expect(app.identity).toBe('app:reports-team');
    expect(runsAsSentence(app.runsAs)).toBe('Runs as app identity reports-team');
    expect(runsAsShort(app.runsAs)).toBe('App: reports-team');
    const user = readSchedule(creatorSchedule('needs_sign_in'))!;
    expect(user.runsAs).toMatchObject({ kind: 'user', signIn: 'needs_sign_in', canSignIn: true });
    expect(runsAsPhrase(user.runsAs)).toBe('with avery@example.com’s own access');
    expect(signInView(user.runsAs)).toEqual({ tone: 'warn', label: 'Needs sign-in' });
    expect(signInView(readSchedule(creatorSchedule('signed_in'))!.runsAs)).toBeNull();
    expect(signInView(readSchedule(creatorSchedule('not_signed_in'))!.runsAs)!.label).toBe(
      'Not signed in yet',
    );
    expect(runsAsPhrase(readSchedule({ key: 'a.b', cron: '* * * * *' })!.runsAs)).toBe(
      'as the automation identity',
    );
  });
});

describe('run as: the report schedule form', () => {
  it('offers the automation identity, each app identity, and "Me" only where Entra sign-in is set up', () => {
    expect(runAsOptions(undefined).map((o) => o.value)).toEqual(['automation']);
    expect(runAsOptions({ apps: ['reports-team'], user: true }).map((o) => o.label)).toEqual([
      'Automation identity',
      'App identity reports-team',
      'Me (my own access)',
    ]);
    // A saved choice the installation no longer offers stays selectable.
    expect(runAsOptions({ apps: [], user: false }, 'app:gone').map((o) => o.value)).toEqual([
      'automation',
      'app:gone',
    ]);
    expect(runAsOptions({ apps: [], user: false }, 'user').map((o) => o.value)).toEqual([
      'automation',
      'user',
    ]);
  });

  it('sends the identity only when it isn’t the automation identity', () => {
    expect(identityFor('user')).toEqual({ user: 'creator' });
    expect(identityFor('app:reports-team')).toEqual({ app: 'reports-team' });
    expect(identityFor('automation')).toBe('automation');
    const report = { key: 'identity.inactive-guests', params: [] };
    const form = {
      runAs: 'automation',
      title: 'x',
      titleEdited: true,
      cron: DEFAULT_CRON_PARTS,
      timezone: 'UTC',
      params: {},
      format: 'xlsx',
      retain: '26',
      emailKey: '',
      teamsKey: '',
      alertEmailKey: '',
      alertTeamsKey: '',
    } as unknown as Parameters<typeof scheduleRequest>[1];
    expect(scheduleRequest(report, form)).not.toHaveProperty('identity');
    expect(scheduleRequest(report, { ...form, runAs: 'user' }).identity).toEqual({ user: 'creator' });
  });

  it('an edited schedule starts from its own identity; delivery options without identities mean none', () => {
    const s = readSchedule(creatorSchedule('signed_in'))!;
    expect(formValuesFromSchedule({ params: [], exportFormats: ['xlsx'] }, s).runAs).toBe('user');
    expect(DeliveryOptionsResponse.parse({ email: {}, teams: {} }).identities).toEqual({
      apps: [],
      user: false,
    });
  });
});
