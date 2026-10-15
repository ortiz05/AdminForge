import { assertSafePath } from '@adminforge/connectors';

// Query strings and fragments travel in `query`, never in the path: the read policy strips them before matching,
// so a path carrying one would be judged differently than it is sent.
describe('assertSafePath: no ? or # in paths', () => {
  it.each([
    '/subscriptions/s/providers/Microsoft.Web/sites/a/config/appsettings/list?api-version=2023-01-01&x=',
    '/users/u#fragment',
    '/users?$filter=x',
  ])('rejects %s', (p) => expect(() => assertSafePath(p, 'ARM')).toThrow(/Invalid ARM path/));

  it('accepts clean paths', () => {
    expect(() => assertSafePath('/users/00000000-0000-4000-8000-000000000001/memberOf')).not.toThrow();
  });
});
