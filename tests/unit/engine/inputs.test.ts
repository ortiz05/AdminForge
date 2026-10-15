import { isTruncated, redact, redactInputs, secretInputValues, storableOutput, validateInputs } from '@adminforge/engine';
import { Params } from '@adminforge/schemas';

const now = new Date('2026-10-15T12:00:00.000Z');
const params = Params.parse({
  userId: { type: 'string', format: 'guid' },
  reason: { type: 'string', minLength: 10, maxLength: 200 },
  count: { type: 'number', integer: true, min: 1, max: 5, default: 2 },
  notify: { type: 'boolean', required: false },
  level: { type: 'enum', values: ['low', { value: 'high', label: 'High' }, 3] },
  tags: { type: 'enum', values: ['a', 'b'], multiple: true, required: false },
  since: { type: 'date', default: '-7d' },
  window: { type: 'dateRange', default: 'P1D' },
  group: { type: 'group', required: false },
  users: { type: 'user', multiple: true, maxItems: 2, required: false },
  sub: { type: 'subscription', required: false },
  res: { type: 'resource', required: false },
  code: { type: 'string', pattern: '^[A-Z]{3}$', required: false },
  mail: { type: 'string', format: 'email', required: false },
  secret: { type: 'string', redact: true, required: false },
  computed: { type: 'number', default: '${ 1 + 1 }' },
});

describe('validateInputs', () => {
  it('applies defaults, coerces unambiguous values and normalises ids', async () => {
    const r = await validateInputs(params, { userId: 'AAAAAAAA-0000-4000-8000-000000000001', reason: 'incident 4411 test', level: '3', notify: 'true', users: ['b@example.com'] }, { now });
    expect(r).toEqual({
      ok: true,
      values: {
        userId: 'aaaaaaaa-0000-4000-8000-000000000001',
        reason: 'incident 4411 test',
        count: 2,
        notify: true,
        level: 3,
        since: '2026-10-08T12:00:00.000Z',
        window: { from: '2026-10-14T12:00:00.000Z', to: '2026-10-15T12:00:00.000Z', timespan: 'P1D' },
        users: ['b@example.com'],
        computed: 2,
      },
    });
  });

  it('reports every problem with the field name', async () => {
    const r = await validateInputs(
      params,
      { userId: 'nope', reason: 'short', count: 9, level: 'mid', tags: ['a', 'z'], group: 'not-a-guid', users: ['a@example.com', 'b@example.com', 'c@example.com'], sub: 'x', res: 'y', code: 'abc', mail: 'x', extra: 1 },
      { now },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.fromEntries(r.errors.map((e) => [e.field, e.message]))).toEqual({
      extra: 'Unknown input.',
      userId: 'Expected a GUID.',
      reason: 'Must be at least 10 characters.',
      count: 'Must be at most 5.',
      level: 'Expected one of: low, high, 3.',
      tags: 'Not an allowed value: z.',
      group: 'Expected a group object id (GUID).',
      users: 'At most 2 items.',
      sub: 'Expected a subscription id (GUID).',
      res: 'Expected an Azure resource id (/subscriptions/…).',
      code: 'Does not match the expected format.',
      mail: 'Expected an email address.',
    });
  });

  it('requires inputs unless required: false or a default; params are optional unless required: true', async () => {
    const p = Params.parse({ a: { type: 'string' }, b: { type: 'string', required: false }, c: { type: 'string', required: true } });
    expect(await validateInputs(p, {}, { now })).toEqual({ ok: false, errors: [{ field: 'a', message: 'a is required.' }, { field: 'c', message: 'c is required.' }] });
    expect(await validateInputs(p, {}, { now, kind: 'params' })).toEqual({ ok: false, errors: [{ field: 'c', message: 'c is required.' }] });
    expect(await validateInputs(undefined, { x: 1 })).toEqual({ ok: false, errors: [{ field: 'x', message: 'Unknown input.' }] });
    expect(await validateInputs(undefined, [] as unknown)).toMatchObject({ ok: false });
    expect(await validateInputs(undefined, undefined)).toEqual({ ok: true, values: {} });
  });
});

describe('redaction', () => {
  it('redacts credential-looking keys and redact: true inputs wherever they appear', () => {
    const body = { passwordProfile: { password: 'p@ss', forceChangePasswordNextSignIn: true }, clientSecret: 's', token: null, note: 'contains Hunter22 inside', nested: [{ apiKey: 'k' }] };
    expect(redact(body, ['Hunter22'])).toEqual({
      passwordProfile: { password: '[redacted]', forceChangePasswordNextSignIn: true },
      clientSecret: '[redacted]',
      token: null,
      note: '[redacted]',
      nested: [{ apiKey: '[redacted]' }],
    });
    const p = Params.parse({ pw: { type: 'string', redact: true }, who: { type: 'string' } });
    expect(secretInputValues(p, { pw: 'Hunter22', who: 'x' })).toEqual(['Hunter22']);
    expect(redactInputs(p, { pw: 'Hunter22', who: 'x' })).toEqual({ pw: '[redacted]', who: 'x' });
  });

  it('truncates stored outputs above the limit', () => {
    expect(storableOutput({ a: 1 }, 100)).toEqual({ a: 1 });
    expect(storableOutput(undefined, 100)).toBeNull();
    const t = storableOutput({ s: 'x'.repeat(500) }, 100);
    expect(isTruncated(t)).toBe(true);
    expect(t).toMatchObject({ bytes: 508, preview: expect.stringMatching(/^\{"s":"xxx/) });
  });
});
