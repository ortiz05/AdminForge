import { evaluate } from '@adminforge/connectors';

// Ported from plan Task 1.12, plus regressions for bugs found while porting.
describe('request policy', () => {
  describe('read mode', () => {
    it('allows Graph GET', () =>
      expect(evaluate('read', { service: 'graph', method: 'get', path: '/users' }).allowed).toBe(true));
    it('denies Graph PATCH with guidance', () => {
      const d = evaluate('read', { service: 'graph', method: 'PATCH', path: '/users/1' });
      expect(d).toEqual({ allowed: false, reason: expect.stringMatching(/Arm write access/) });
    });
    it('allows Resource Graph queries but not listKeys', () => {
      expect(
        evaluate('read', {
          service: 'arm',
          method: 'POST',
          path: '/providers/Microsoft.ResourceGraph/resources',
        }).allowed,
      ).toBe(true);
      expect(
        evaluate('read', {
          service: 'arm',
          method: 'POST',
          path: '/subscriptions/s/resourceGroups/r/providers/Microsoft.Storage/storageAccounts/a/listKeys',
        }).allowed,
      ).toBe(false);
    });
    it('checks every $batch sub-request', () => {
      const ok = { requests: [{ id: '1', method: 'GET', url: '/users' }] };
      const bad = {
        requests: [
          { id: '1', method: 'GET', url: '/users' },
          { id: '2', method: 'DELETE', url: '/groups/9' },
        ],
      };
      expect(evaluate('read', { service: 'graph', method: 'POST', path: '/$batch', body: ok }).allowed).toBe(
        true,
      );
      expect(evaluate('read', { service: 'graph', method: 'POST', path: '/$batch', body: bad }).allowed).toBe(
        false,
      );
    });
    it('allows only Get-* cmdlets for Exchange and Teams', () => {
      expect(
        evaluate('read', {
          service: 'exchange',
          method: 'POST',
          path: '/InvokeCommand',
          cmdlet: 'Get-Mailbox',
        }).allowed,
      ).toBe(true);
      expect(
        evaluate('read', {
          service: 'exchange',
          method: 'POST',
          path: '/InvokeCommand',
          cmdlet: 'Set-Mailbox',
        }).allowed,
      ).toBe(false);
    });
    it('allows runner jobs only for steps declared read', () => {
      expect(evaluate('read', { service: 'runner', method: 'POST', path: '/jobs' }).allowed).toBe(true);
      expect(
        evaluate('read', { service: 'runner', method: 'POST', path: '/jobs', declaredWrite: true }).allowed,
      ).toBe(false);
    });
    it('allows Log Analytics queries', () =>
      expect(
        evaluate('read', {
          service: 'logAnalytics',
          method: 'POST',
          path: '/v1/workspaces/00000000-0000-4000-8000-000000000123/query',
        }).allowed,
      ).toBe(true));
    it('rejects a malformed $batch body', () =>
      expect(evaluate('read', { service: 'graph', method: 'POST', path: '/$batch', body: {} }).allowed).toBe(
        false,
      ));
  });

  describe('write mode', () => {
    it('denies writes not declared by a published definition', () =>
      expect(evaluate('write', { service: 'graph', method: 'PATCH', path: '/users/1' }).allowed).toBe(false));
    it('allows declared writes', () =>
      expect(
        evaluate('write', { service: 'graph', method: 'PATCH', path: '/users/1', declaredWrite: true })
          .allowed,
      ).toBe(true));
    // Bug fix: an armed session used to block reads that are POSTs (Get-* cmdlets, read-only runner jobs).
    it('still allows everything read mode allows', () => {
      expect(
        evaluate('write', {
          service: 'exchange',
          method: 'POST',
          path: '/InvokeCommand',
          cmdlet: 'Get-Mailbox',
        }).allowed,
      ).toBe(true);
      expect(evaluate('write', { service: 'runner', method: 'POST', path: '/jobs' }).allowed).toBe(true);
      expect(evaluate('write', { service: 'graph', method: 'GET', path: '/users' }).allowed).toBe(true);
    });
    // Bug fix: $batch used to be allowed wholesale in write mode, smuggling undeclared writes.
    it('checks $batch sub-requests unless the batch is a declared write', () => {
      const bad = { requests: [{ id: '1', method: 'DELETE', url: '/groups/9' }] };
      expect(
        evaluate('write', { service: 'graph', method: 'POST', path: '/$batch', body: bad }).allowed,
      ).toBe(false);
      expect(
        evaluate('write', {
          service: 'graph',
          method: 'POST',
          path: '/$batch',
          body: bad,
          declaredWrite: true,
        }).allowed,
      ).toBe(true);
    });
    it('denies undeclared non-Get cmdlets', () =>
      expect(
        evaluate('write', {
          service: 'exchange',
          method: 'POST',
          path: '/InvokeCommand',
          cmdlet: 'Set-Mailbox',
        }),
      ).toEqual({
        allowed: false,
        reason: expect.stringMatching(/published playbook/),
      }));
  });

  describe('path hygiene', () => {
    // Bug fix: an unanchored allowlist pattern could match text after "?" and wave a write POST through.
    it('ignores query strings when matching read-only POSTs', () =>
      expect(
        evaluate('read', {
          service: 'arm',
          method: 'POST',
          path: '/subscriptions/s/resourceGroups/r/providers/Microsoft.Storage/storageAccounts/a/listKeys?x=/providers/Microsoft.Insights/metrics',
        }).allowed,
      ).toBe(false));
    it.each(['/users/../me', '/users/%2e%2e/me', '/users%2Fx', '/users\\x', 'users'])(
      'refuses unclean path %s',
      (path) =>
        expect(evaluate('read', { service: 'graph', method: 'GET', path })).toEqual({
          allowed: false,
          reason: expect.stringMatching(/not a clean service path/),
        }),
    );
    it('refuses $batch sub-requests with unclean paths', () =>
      expect(
        evaluate('read', {
          service: 'graph',
          method: 'POST',
          path: '/$batch',
          body: { requests: [{ id: '1', method: 'GET', url: '/users/../me' }] },
        }).allowed,
      ).toBe(false));
  });

  describe('function connections', () => {
    it('allow POST to an operation the connection declares read', () => {
      expect(
        evaluate('read', { service: 'function', method: 'POST', path: '/api/search', declaredRead: true })
          .allowed,
      ).toBe(true);
      expect(evaluate('read', { service: 'function', method: 'POST', path: '/api/search' }).allowed).toBe(
        false,
      );
    });
    it('never treat declaredRead as permission for other services', () =>
      expect(
        evaluate('read', { service: 'graph', method: 'POST', path: '/users', declaredRead: true }).allowed,
      ).toBe(false));
  });
});
