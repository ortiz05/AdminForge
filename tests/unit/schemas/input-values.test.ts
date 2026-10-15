import { inputErrors, inputsSchema, isInputRequired, literalDefault, type Params } from '@adminforge/schemas';

const params = {
  userId: { type: 'string', format: 'guid', label: 'User', picker: 'user' },
  reason: { type: 'string', label: 'Reason', minLength: 10, multiline: true },
  minutes: { type: 'number', label: 'Valid for', min: 10, max: 600, integer: true, default: 60 },
  once: { type: 'boolean', default: true },
  users: { type: 'user', multiple: true, maxItems: 2 },
  level: { type: 'enum', values: ['low', { value: 'high', label: 'High' }], required: false },
  since: { type: 'date', default: '${ now }' },
} as unknown as Params;

const parse = (values: Record<string, unknown>, omit?: string[]) => {
  const r = inputsSchema(params, { omit }).safeParse(values);
  return r.success
    ? { ok: true as const, data: r.data }
    : { ok: false as const, errors: inputErrors(r.error) };
};

describe('inputsSchema (client-side run form validation)', () => {
  it('reports required, length, format and range problems per field, in the engine’s words', () => {
    const r = parse({ userId: 'not-a-guid', reason: 'short', minutes: '5.5', users: ['x'] });
    expect(r).toEqual({
      ok: false,
      errors: {
        userId: 'Expected a GUID.',
        reason: 'Must be at least 10 characters.',
        minutes: 'Expected a whole number.',
        users: 'Expected a user object id (GUID) or user principal name.',
      },
    });
  });

  it('blank required inputs say "<label> is required."', () => {
    const r = parse({ userId: '  ', reason: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toMatchObject({ userId: 'User is required.', reason: 'Reason is required.' });
  });

  it('coerces numbers and booleans typed as text, drops unknown keys and blanks', () => {
    const r = parse({
      userId: '3F2A8C1E-5B7D-4E19-9A6C-2D8E4F1B9C1D',
      reason: 'INC-4821 account compromised',
      minutes: '120',
      once: 'false',
      users: ['a@example.com'],
      level: '',
      extra: 'nope',
    });
    expect(r).toEqual({
      ok: true,
      data: {
        userId: '3F2A8C1E-5B7D-4E19-9A6C-2D8E4F1B9C1D',
        reason: 'INC-4821 account compromised',
        minutes: 120,
        once: false,
        users: ['a@example.com'],
      },
    });
  });

  it('enforces maxItems and allowed enum values', () => {
    const r = parse({
      userId: '3f2a8c1e-5b7d-4e19-9a6c-2d8e4f1b9c1d',
      reason: 'long enough reason',
      users: ['a@b.co', 'c@d.co', 'e@f.co'],
      level: 'medium',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual({ users: 'At most 2 items.', level: 'Expected one of: low, high.' });
  });

  it('omits keys that bulk items supply', () => {
    expect(parse({ reason: 'Quarterly leaver sweep' }, ['userId', 'users']).ok).toBe(true);
  });

  it('inputs with a default (literal or expression) are optional; only literal defaults prefill the form', () => {
    expect(isInputRequired(params.minutes!)).toBe(false);
    expect(isInputRequired(params.since!)).toBe(false);
    expect(isInputRequired(params.userId!)).toBe(true);
    expect(literalDefault(params.minutes!)).toBe(60);
    expect(literalDefault(params.since!)).toBeUndefined();
  });
});
