import { InvalidParams, resolveParams } from '@adminforge/api/src/datasources/params';
import type { Params } from '@adminforge/schemas';

// fetch drops TAB/LF/CR from URLs before resolving dot segments, so a value like ".\t." becomes ".." on the wire.
// Page params refuse control characters up front (multi-line text keeps its line breaks).
const scope = { now: '2026-10-15T12:00:00.000Z', user: { oid: 'u' }, env: {} };
const DECL = {
  q: { type: 'string' },
  notes: { type: 'string', multiline: true },
  user: { type: 'user' },
  users: { type: 'user', multiple: true },
} as unknown as Params;

const issues = async (input: Record<string, unknown>) =>
  resolveParams(DECL, input, scope).then(
    () => [],
    (err: unknown) => (err as InvalidParams).issues,
  );

describe('control characters in params', () => {
  it.each(['.\t.', 'a\nb', 'a\rb', 'x\u0000', 'x\u007f'])('a text param refuses %j', async (q) =>
    expect(await issues({ q })).toEqual([
      { param: 'q', message: 'must be a single line without control characters' },
    ]),
  );

  it('multi-line text keeps line breaks and tabs, but not other controls', async () => {
    expect(await resolveParams(DECL, { notes: 'line 1\r\nline\t2' }, scope)).toMatchObject({
      notes: 'line 1\r\nline\t2',
    });
    expect(await issues({ notes: 'bell\u0007' })).toEqual([
      { param: 'notes', message: 'contains control characters' },
    ]);
  });

  it('entity ids refuse them too', async () => {
    expect(await issues({ user: '.\t.' })).toEqual([{ param: 'user', message: 'must be an id' }]);
    expect(await issues({ users: ['ok-id', 'bad\nid'] })).toEqual([
      { param: 'users', message: 'must be an id' },
    ]);
    expect(await resolveParams(DECL, { user: '00000000-0000-4000-8000-000000000001' }, scope)).toMatchObject({
      user: '00000000-0000-4000-8000-000000000001',
    });
  });
});
