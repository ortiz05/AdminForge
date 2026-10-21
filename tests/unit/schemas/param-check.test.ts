import { parseAdvanced } from '@adminforge/api/src/datasources/advanced';
import { InvalidParams, resolveParams } from '@adminforge/api/src/datasources/params';
import { validateInputs } from '@adminforge/engine';
import {
  advancedOpsFor,
  checkAdvancedValue,
  checkInputValue,
  checkParam,
  inputErrors,
  inputsSchema,
  type AdvancedField,
  type Param,
  type Params,
} from '@adminforge/schemas';
import { coerceParam } from '@adminforge/web/src/renderer/params';
import { typedValue } from '@adminforge/web/src/renderer/QueryBuilder';

// Browser and API check page params, query-builder values and run inputs with the same functions (design review
// D-06): what the page or run form accepts, the API accepts, and both say the same thing about what they refuse.
const NOW = new Date('2026-10-15T12:00:00.000Z');
const scope = { now: NOW.toISOString(), user: { oid: 'u' }, env: {} };

const PARAMS: Params = {
  q: { type: 'string', maxLength: 20 },
  pool: { type: 'string', pattern: '[A-Za-z0-9@._ -]{0,64}' },
  host: { type: 'string', format: 'hostname' },
  top: { type: 'number', min: 1, max: 999, integer: true },
  expired: { type: 'boolean' },
  kind: { type: 'enum', values: ['Member', 'Guest'] },
  tags: { type: 'enum', values: ['a', 'b'], multiple: true },
  since: { type: 'date' },
  when: { type: 'dateRange', max: 'P30D' },
  id: { type: 'guid' },
  users: { type: 'user', multiple: true, maxItems: 2 },
};

/** The API's issue for one param (undefined when it accepts the value). */
async function apiIssue(name: string, raw: unknown): Promise<string | undefined> {
  try {
    await resolveParams(PARAMS, { [name]: raw }, scope);
    return undefined;
  } catch (e) {
    if (!(e instanceof InvalidParams)) throw e;
    return e.issues.find((i) => i.param === name)?.message;
  }
}

describe('page params: one check for the page and the API', () => {
  it('coerces the way URLs deliver values', () => {
    expect(checkParam(PARAMS.top!, '42', NOW)).toEqual({ value: 42 });
    expect(checkParam(PARAMS.expired!, 'false', NOW)).toEqual({ value: false });
    expect(checkParam(PARAMS.tags!, 'a,b', NOW)).toEqual({ value: ['a', 'b'] });
    expect(checkParam(PARAMS.id!, ' 3F2A8C1E-5B7D-4E19-9A6C-2D8E4F1B9C1D ', NOW)).toEqual({
      value: '3f2a8c1e-5b7d-4e19-9a6c-2d8e4f1b9c1d',
    });
    expect(checkParam(PARAMS.since!, '-1d', NOW)).toEqual({ value: '2026-10-14T12:00:00.000Z' });
    expect(checkParam(PARAMS.when!, 'P7D', NOW)).toMatchObject({
      value: { from: '2026-10-08T12:00:00.000Z', to: '2026-10-15T12:00:00.000Z' },
    });
  });

  it.each<[string, unknown]>([
    ['q', 'x'.repeat(21)],
    ['q', 'line\nbreak'],
    ['pool', 'pool;drop'],
    ['pool', 'x'.repeat(65)],
    ['host', '-bad-.example.com'],
    ['top', '2000'],
    ['top', '1.5'],
    ['top', 'many'],
    ['expired', 'yes'],
    ['kind', 'Robot'],
    ['tags', 'a,z'],
    ['since', '2026-13-45'],
    ['since', 'yesterday'],
    ['when', 'P90D'],
    ['when', { from: '2026-10-10', to: '2026-10-01' }],
    ['id', 'not-a-guid'],
    ['users', ['a', 'b', 'c']],
  ])('%s = %j: the page reports what the API refuses, in the same words', async (name, raw) => {
    const api = await apiIssue(name, raw);
    const [, browser] = coerceParam(PARAMS[name]!, raw, NOW);
    expect(api).toBeDefined();
    expect(browser).toBe(api);
  });

  it.each<[string, unknown]>([
    ['q', 'hello'],
    ['pool', 'Pool 01'],
    ['host', 'host-1.example.com'],
    ['top', '50'],
    ['kind', 'Guest'],
    ['since', 'today'],
    ['when', { from: '2026-10-01', to: '2026-10-02' }],
    ['id', '3f2a8c1e-5b7d-4e19-9a6c-2d8e4f1b9c1d'],
    ['users', 'a,b'],
  ])('%s = %j: both accept it', async (name, raw) => {
    // The page splits comma-separated ids from a hand-edited link; it sends the list.
    const sent = coerceParam(PARAMS[name]!, raw, NOW);
    expect(sent[1]).toBeUndefined();
    expect(await apiIssue(name, sent[0])).toBeUndefined();
  });

  it('messages read after the label', () => {
    expect(coerceParam(PARAMS.top!, '2000', NOW)[1]).toBe('must be at most 999');
    expect(coerceParam(PARAMS.pool!, 'a;b', NOW)[1]).toBe('does not match the expected format');
  });
});

describe('query-builder values: the builder runs the API check', () => {
  const FIELDS: AdvancedField[] = [
    { field: 'created', label: 'Created', type: 'date' },
    { field: 'seats', label: 'Seats', type: 'number' },
    { field: 'owner', label: 'Owner', type: 'guid' },
    { field: 'kind', label: 'Kind', type: 'enum', values: ['Member', 'Guest'] },
    { field: 'name', label: 'Name', type: 'string' },
  ];
  const spec = { dialect: 'odata' as const, fields: FIELDS };
  const apiAccepts = (field: string, value: unknown) => {
    try {
      const op = advancedOpsFor(FIELDS.find((f) => f.field === field)!)[0];
      parseAdvanced(spec, { all: [{ field, op, value }] }, NOW);
      return true;
    } catch {
      return false;
    }
  };

  it.each<[string, string]>([
    ['created', '2026-10-01'],
    ['created', '-30d'],
    ['created', '2026-13-45'],
    ['seats', '12'],
    ['seats', '12 or 1 eq 1'],
    ['owner', '3F2A8C1E-5B7D-4E19-9A6C-2D8E4F1B9C1D'],
    ['owner', 'nope'],
    ['kind', 'Guest'],
    ['kind', 'Admin'],
    ['name', 'Avery'],
    ['name', 'a\u0000b'],
    ['name', 'x'.repeat(257)],
  ])('%s = %j', (field, text) => {
    const f = FIELDS.find((x) => x.field === field)!;
    const typed = typedValue(f, text, NOW);
    expect('value' in typed).toBe(apiAccepts(field, 'value' in typed ? typed.value : text));
  });

  it('keeps relative dates as typed; the API resolves them per request', () => {
    expect(typedValue(FIELDS[0]!, '-30d', NOW)).toEqual({ value: '-30d' });
    expect(checkAdvancedValue(FIELDS[0]!, '-30d', NOW)).toEqual({ value: '2026-09-15T12:00:00.000Z' });
  });
});

describe('run inputs: the form and the engine say the same thing', () => {
  const INPUTS = {
    userId: { type: 'string', format: 'guid', label: 'User' },
    code: { type: 'string', pattern: '[0-9]+', label: 'Code' },
    minutes: { type: 'number', min: 10, max: 600, integer: true },
    level: { type: 'enum', values: ['low', 'high'] },
    users: { type: 'user', multiple: true, maxItems: 2 },
    since: { type: 'date' },
    window: { type: 'dateRange' },
    group: { type: 'group' },
  } as unknown as Params;

  it.each<[string, unknown]>([
    ['userId', 'not-a-guid'],
    ['code', 'a42'],
    ['code', '42a'],
    ['minutes', '5.5'],
    ['minutes', '900'],
    ['level', 'medium'],
    ['users', ['a@example.com', 'b@example.com', 'c@example.com']],
    ['users', ['x']],
    ['since', 'whenever'],
    ['window', { from: '2026-10-10', to: '2026-10-01' }],
    ['group', 'not-a-guid'],
  ])('%s = %j', async (name, raw) => {
    const engine = await validateInputs(INPUTS, { [name]: raw }, { now: NOW });
    const browser = inputsSchema(INPUTS).safeParse({ [name]: raw });
    const engineError = engine.ok ? undefined : engine.errors.find((e) => e.field === name)?.message;
    const browserError = browser.success ? undefined : inputErrors(browser.error)[name];
    expect(engineError).toBeDefined();
    expect(browserError).toBe(engineError);
  });

  it('patterns are anchored for inputs too (they used to match anywhere in the value)', () => {
    const p = INPUTS.code as Param;
    expect(checkInputValue(p, '42', NOW)).toEqual({ value: '42' });
    expect(checkInputValue(p, 'abc42def', NOW)).toEqual({ error: 'Does not match the expected format.' });
  });

  it('an unsafe pattern never runs: the input is refused, not matched', () => {
    const p = { type: 'string', pattern: '(a+)+$' } as Param;
    expect(checkInputValue(p, 'aaaa', NOW)).toEqual({ error: 'The definition declares an invalid pattern.' });
    expect(checkParam(p, 'aaaa', NOW)).toEqual({
      error: "can't be checked: the page declares a format AdminForge doesn't accept",
    });
  });
});
