import { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import type { AuthClient } from '@adminforge/api/src/auth/types';
import {
  createOutboundExecutor,
  outboundAppError,
  readableMessage,
  USAGE_REPORTS_UNAVAILABLE,
} from '@adminforge/api/src/execution/outbound';

// Microsoft 365 usage reports answer 404 UnknownTenantId when the tenant has no Microsoft 365 subscription, with a
// whole JSON error body stuffed into error.message. People must see a written message, never that JSON.
const NOW = new Date('2026-10-15T12:00:00.000Z');
const INNER = JSON.stringify({
  error: {
    code: 'UnknownTenantId',
    message: 'We do not recognize this tenant ID 11111111-2222-4333-8444-555555555555.',
  },
});

function executor(body: unknown, contentType = 'application/json') {
  const auth = { token: async () => 'token' } as unknown as AuthClient;
  return createOutboundExecutor({
    config: {
      DATA_MODE: 'live',
      AF_SPO_TENANT_NAME: undefined,
      OUTBOUND_CONCURRENCY: 4,
      OUTBOUND_USER_CONCURRENCY: 2,
      OUTBOUND_TIMEOUT_MS: 5000,
      TOKEN_CACHE_KEY: undefined,
    },
    broker: new TokenBroker(auth, {}, () => NOW),
    auth,
    automation: { clientId: 'a', credential: 'secret', token: async () => 'token-app' },
    fetch: async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status: 404,
        headers: { 'content-type': contentType, 'request-id': 'ms-req-9' },
      }),
    now: () => NOW,
    sleep: async () => undefined,
    maxRetries: 0,
  });
}

const call = {
  service: 'graph' as const,
  method: 'GET',
  path: "/reports/getOffice365ActiveUserDetail(period='D30')",
  requires: { licences: ['m365'] },
};

describe('usage reports without Microsoft 365: licence_required with a written message', () => {
  it.each([
    ['wrapped in UnknownError', { error: { code: 'UnknownError', message: INNER } }],
    [
      'as the code itself',
      { error: { code: 'UnknownTenantId', message: 'We do not recognize this tenant ID.' } },
    ],
  ])('%s', async (_label, body) => {
    const err = await executor(body)
      .execute({ kind: 'automation', mode: 'read' }, call)
      .catch((e: unknown) => e);
    const app = outboundAppError(err);
    expect(app).toMatchObject({ status: 403, code: 'licence_required', message: USAGE_REPORTS_UNAVAILABLE });
    expect(app.message).not.toMatch(/[{}"]/);
    expect(app.extras.hint).toContain('m365');
  });
});

describe('readableMessage', () => {
  it('passes prose through', () =>
    expect(readableMessage('Insufficient privileges.')).toBe('Insufficient privileges.'));
  it('unwraps nested JSON error bodies to the innermost message', () =>
    expect(readableMessage(JSON.stringify({ error: { code: 'X', message: INNER } }))).toBe(
      'We do not recognize this tenant ID 11111111-2222-4333-8444-555555555555.',
    ));
  it.each(['{"odata.error":{"code":"x"}}', '{not json', '[1,2]'])('never shows JSON as-is: %s', (m) =>
    expect(readableMessage(m)).toBe('Microsoft returned an error without a readable description.'),
  );
});
