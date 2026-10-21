import { FORBIDDEN_HEADERS, isForbiddenHeader } from '@adminforge/connectors';
import { FORBIDDEN_HEADER_NAMES, GraphRequestSpec } from '@adminforge/schemas';

// S-23 follow-up: the request policy judges the method a request is sent with. A method-override header would let a
// server that honours it (ASP.NET Core's UseHttpMethodOverride, Express's method-override — both on POST) treat an
// unarmed `readPost` POST as a DELETE or PATCH, so content may never set one: validate refuses it, the executor and
// the engine refuse it at run time, and the HTTP client drops it.
const OVERRIDES = ['X-HTTP-Method-Override', 'X-HTTP-Method', 'X-Method-Override'];

describe('method-override headers', () => {
  it.each(OVERRIDES)('%s is refused in any case, at run time and at validate time', (name) => {
    expect(isForbiddenHeader(name)).toBe(true);
    expect(isForbiddenHeader(name.toLowerCase())).toBe(true);
    expect(FORBIDDEN_HEADERS.has(name.toLowerCase())).toBe(true);
    expect(FORBIDDEN_HEADER_NAMES).toContain(name.toLowerCase());
    const r = GraphRequestSpec.safeParse({ path: '/users', headers: { [name]: 'DELETE' } });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toMatch(/method/i);
    expect(r.error!.issues[0]!.message).not.toMatch(/sign-in token/);
  });
});
