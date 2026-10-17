import { parseDefinition, type Schedule } from '@adminforge/schemas';
import { FakeDefinitions, READER, schedulesApp } from './schedules-helpers';

// POST /api/schedules/preview takes cron or English (`every`) and answers with the cron, a sentence naming the zone,
// the next five runs (server-side, DST-aware) and whether a schedule created in the portal would refuse it as too
// frequent; POST /api/schedules/scaffold writes `every:` into the YAML when it was given English.
const report = {
  kind: 'report' as const,
  id: 'identity.inactive-guests',
  version: '1.0.0',
  title: 'Inactive guests',
  owner: 'identity-team',
};

async function setup() {
  const t = await schedulesApp({ defs: new FakeDefinitions().set(report) });
  const user = await t.login(READER, ['Portal.Reader']);
  return { t, user };
}

describe('schedule preview in plain English', () => {
  it('compiles English, names the zone and lists the next five runs', async () => {
    const { t, user } = await setup();
    const res = await user.post('/api/schedules/preview', {
      every: 'first Monday of the month at 8:30',
      timezone: 'Europe/London',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      valid: true,
      cron: '30 8 * * 1#1',
      text: 'On the first Monday of every month at 08:30 Europe/London',
      timezone: 'Europe/London',
      tooFrequent: false,
    });
    expect(body.next).toHaveLength(5);
    // Every run is a Monday in the first week, at 08:30 London time.
    for (const iso of body.next as string[]) {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        weekday: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(iso));
      const get = (type: string) => parts.find((p) => p.type === type)?.value;
      expect([get('weekday'), Number(get('day')) <= 7, `${get('hour')}:${get('minute')}`]).toEqual([
        'Mon',
        true,
        '08:30',
      ]);
    }
    await t.close();
  });

  it('a zone named in the text wins, and too-frequent cadences are flagged', async () => {
    const { t, user } = await setup();
    const zoned = (
      await user.post('/api/schedules/preview', {
        every: 'every weekday at 7:00 am America/New_York',
        timezone: 'UTC',
      })
    ).json();
    expect(zoned).toMatchObject({ valid: true, cron: '0 7 * * 1-5', timezone: 'America/New_York' });
    const often = (
      await user.post('/api/schedules/preview', { every: 'every 15 minutes', timezone: 'UTC' })
    ).json();
    expect(often).toMatchObject({ valid: true, cron: '*/15 * * * *', tooFrequent: true });
    await t.close();
  });

  it('English it can’t read is valid: false with the reason, not an error', async () => {
    const { t, user } = await setup();
    const res = await user.post('/api/schedules/preview', { every: 'every tuesdy at 7', timezone: 'UTC' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      valid: false,
      cron: null,
      next: [],
      problem: expect.stringMatching(/tuesdy/),
    });
    await t.close();
  });

  it('needs exactly one of cron and every', async () => {
    const { t, user } = await setup();
    expect((await user.post('/api/schedules/preview', { timezone: 'UTC' })).statusCode).toBe(400);
    expect(
      (
        await user.post('/api/schedules/preview', {
          cron: '0 7 * * 1',
          every: 'every Monday at 07:00',
          timezone: 'UTC',
        })
      ).statusCode,
    ).toBe(400);
    await t.close();
  });

  it('scaffolds `every:` (the describer’s sentence) when given English, and it validates back to the same cron', async () => {
    const { t, user } = await setup();
    const res = await user.post('/api/schedules/scaffold', {
      title: 'Monthly guests review',
      every: 'first monday of the month at 8:30',
      timezone: 'Europe/London',
      job: { kind: 'report', ref: 'identity.inactive-guests', format: 'xlsx' },
    });
    expect(res.statusCode).toBe(200);
    const { yaml, path } = res.json() as { yaml: string; path: string };
    expect(yaml).toMatch(/^every: On the first Monday of every month at 08:30$/m);
    expect(yaml).not.toMatch(/^cron:/m);
    expect(yaml).toMatch(/# Runs: On the first Monday of every month at 08:30 Europe\/London\./);
    const parsed = parseDefinition(yaml, path.replace(/^portal\/content\//, ''));
    expect(parsed.ok && (parsed.def as Schedule)).toMatchObject({
      cron: '30 8 * * 1#1',
      timezone: 'Europe/London',
    });

    const bad = await user.post('/api/schedules/scaffold', {
      title: 'Typo',
      every: 'every tuesdy at 7',
      timezone: 'UTC',
      job: { kind: 'report', ref: 'identity.inactive-guests', format: 'xlsx' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({
      code: 'invalid_cron',
      message: expect.stringMatching(/tuesdy/),
    });
    await t.close();
  });
});
