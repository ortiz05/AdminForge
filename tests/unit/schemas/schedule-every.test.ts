import { jsonSchemas, validateDefinition, type Schedule } from '@adminforge/schemas';
import { ENVELOPE, errors, ok } from './helpers';

// A schedule may say when it runs in English (`every:`) instead of cron. Validation compiles it, so `cron` is always
// set on the parsed definition — the scheduler, the API and the sync read only `cron`.

const job = 'job:\n  kind: probe\n  select: { tags: [sweep-15m] }\n';
const head = ENVELOPE('schedule', 'probes.example');

describe('schedule `every:`', () => {
  it('compiles English to cron and keeps the text', () => {
    const def = ok<Schedule>(
      `${head}every: "first Monday of the month at 08:30"\ntimezone: Europe/London\n${job}`,
    );
    expect(def).toMatchObject({ cron: '30 8 * * 1#1', every: 'first Monday of the month at 08:30' });
  });

  it.each([
    ['every weekday at 07:00', '0 7 * * 1-5'],
    ['every 4 hours', '0 */4 * * *'],
    ['last day of the month at 23:00', '0 23 L * *'],
    ['mon, wed and fri at 18:00', '0 18 * * 1,3,5'],
  ])('every: %s → cron %s', (every, cron) =>
    expect(ok<Schedule>(`${head}every: "${every}"\n${job}`).cron).toBe(cron),
  );

  it('refuses English it can’t read, naming the word', () => {
    const e = errors(`${head}every: "every tuesdy at 7"\n${job}`);
    expect(e).toEqual([
      expect.objectContaining({ path: 'every', message: expect.stringMatching(/“tuesdy”/) }),
    ]);
  });

  it('needs cron or every', () => {
    expect(errors(`${head}${job}`)).toEqual([
      expect.objectContaining({ path: 'cron', message: expect.stringMatching(/`cron`.*or `every`/) }),
    ]);
  });

  it('refuses both when they disagree, and a time zone inside every', () => {
    expect(errors(`${head}cron: "0 6 * * 1"\nevery: "every Monday at 07:00"\n${job}`)).toEqual([
      expect.objectContaining({
        path: 'every',
        message: expect.stringMatching(/either `cron` or `every`.*0 7 \* \* 1/),
      }),
    ]);
    expect(errors(`${head}every: "every Monday at 07:00 Europe/London"\n${job}`)).toEqual([
      expect.objectContaining({ path: 'every', message: expect.stringMatching(/timezone: Europe\/London/) }),
    ]);
  });

  it('a parsed definition (cron filled in) validates again, e.g. in the content-health job', () => {
    const def = ok<Schedule>(`${head}every: "every Monday at 07:00"\n${job}`);
    const again = validateDefinition(JSON.parse(JSON.stringify(def)));
    expect(again.ok && again.def).toMatchObject({ cron: '0 7 * * 1', every: 'every Monday at 07:00' });
  });

  it('the JSON schema offers every, with examples, and requires neither field on its own', () => {
    type Node = { $ref?: string; description?: string; examples?: unknown[] };
    const schema = jsonSchemas().schedule as {
      properties: Record<string, Node>;
      required: string[];
      definitions?: Record<string, Node>;
    };
    const every = schema.properties.every!;
    const node = every.$ref ? schema.definitions![every.$ref.replace('#/definitions/', '')]! : every;
    expect(node.examples).toContain('every weekday at 07:00');
    expect(node.description).toMatch(/plain English/);
    expect(schema.required).not.toContain('cron');
    expect(schema.required).not.toContain('every');
  });
});
