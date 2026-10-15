import { ApiError } from '@adminforge/connectors';
import { errorHint } from '@adminforge/api/src/execution/outbound';

const identity = { kind: 'delegated' as const, mode: 'read' as const };

describe('errorHint licence classification', () => {
  it('treats 404 UnknownTenantId from Microsoft 365 usage reports as a missing licence', () => {
    const err = new ApiError(404, 'UnknownTenantId', 'We do not recognize this tenant ID.');
    expect(errorHint(err, 'graph', identity, { licences: ['m365'] } as never)).toMatchObject({ licence: true });
  });
  it('keeps other 404s as not-found', () => {
    const err = new ApiError(404, 'Request_ResourceNotFound', 'Resource not found.');
    expect(errorHint(err, 'graph', identity).licence).toBe(false);
  });
});
