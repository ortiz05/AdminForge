import { evaluate } from '@adminforge/connectors';

// The scheduler confirms a portal schedule's creator still holds the portal roles with checkMemberObjects (a read that
// takes its ids as a POST body), as the automation identity in read mode.
describe('read policy: membership checks', () => {
  it.each(['checkMemberObjects', 'checkMemberGroups', 'getMemberGroups', 'getMemberObjects'])(
    'allows POST /users/{id}/%s',
    (fn) =>
      expect(
        evaluate('read', {
          service: 'graph',
          method: 'POST',
          path: `/users/00000000-0000-4000-8000-0000000000a1/${fn}`,
        }).allowed,
      ).toBe(true),
  );
  it('still refuses other user POSTs and nested paths', () => {
    for (const path of [
      '/users/00000000-0000-4000-8000-0000000000a1/revokeSignInSessions',
      '/users/x/y/checkMemberObjects',
      '/groups/x/checkMemberObjects',
    ])
      expect(evaluate('read', { service: 'graph', method: 'POST', path }).allowed).toBe(false);
  });
});
