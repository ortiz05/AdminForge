import { evaluate } from '@adminforge/connectors';

// S-23: a connection operation declared `mode: read` that POSTs runs unarmed only when the connection also says
// `readPost: true` — a reviewed statement that this POST only reads. A read-mode POST without it needs write access
// like any other POST (and validate refuses to publish it).
const fn = (over: Record<string, unknown> = {}) => ({
  service: 'function' as const,
  method: 'POST',
  path: '/api/employees/search',
  declaredRead: true,
  ...over,
});

describe('function connections: read-mode POST (S-23)', () => {
  it('runs unarmed only with readPost', () => {
    expect(evaluate('read', fn({ readPost: true })).allowed).toBe(true);
    const d = evaluate('read', fn());
    expect(d.allowed).toBe(false);
    expect(d).toMatchObject({ reason: expect.stringMatching(/readPost/) });
  });

  it('GET operations declared read need nothing more', () =>
    expect(evaluate('read', fn({ method: 'GET', path: '/api/employees' })).allowed).toBe(true));

  it('readPost never stands in for the connection’s mode: read', () =>
    expect(evaluate('read', fn({ declaredRead: false, readPost: true })).allowed).toBe(false));

  it('readPost means nothing outside function connections', () => {
    expect(
      evaluate('read', { service: 'graph', method: 'POST', path: '/users', readPost: true }).allowed,
    ).toBe(false);
    expect(
      evaluate('read', {
        service: 'arm',
        method: 'POST',
        path: '/subscriptions/x/providers/y/listKeys',
        readPost: true,
      }).allowed,
    ).toBe(false);
  });

  it('other methods stay writes even with readPost', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE'])
      expect(evaluate('read', fn({ method, readPost: true })).allowed).toBe(false);
  });

  it('armed: a declared write still runs; an undeclared read-mode POST does not', () => {
    expect(evaluate('write', fn({ declaredRead: false, declaredWrite: true })).allowed).toBe(true);
    expect(evaluate('write', fn({ readPost: true })).allowed).toBe(true);
    expect(evaluate('write', fn()).allowed).toBe(false);
  });
});
