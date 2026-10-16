import { ApiError } from '@adminforge/connectors';
import {
  errorHint,
  USAGE_REPORTS_UNAVAILABLE,
  USER_NOT_LICENSED,
} from '@adminforge/api/src/execution/outbound';

// Graph's Teams APIs answer delegated calls only for people who hold a Teams licence themselves; that is not a tenant
// licence gap, so it must not read "your tenant's licences don't include this".
const delegated = { kind: 'delegated' as const, mode: 'read' as const };
const teamsError = (status: number) =>
  new ApiError(
    status,
    'Forbidden',
    'Failed to get license information for the user. Ensure user has a valid Office365 license assigned to them.',
    'req-1',
  );

describe('errorHint: calls Microsoft answers only for licensed people', () => {
  it.each([400, 403, 404])('status %i: the signed-in person needs a licence, not the tenant', (status) => {
    const h = errorHint(teamsError(status), 'graph', delegated, { licences: ['teams'] } as never);
    expect(h).toMatchObject({ licence: false, message: USER_NOT_LICENSED });
    expect(h.hint).toContain('assign you a licence');
    expect(h.hint).toContain('Microsoft Teams');
    expect(h.hint).not.toMatch(/tenant's licences/);
    expect(h.hint).toContain('req-1');
  });

  it("only for Graph: another service talking about some user's licence keeps its own handling", () => {
    const h = errorHint(teamsError(403), 'exchange', delegated);
    expect(h.message).not.toBe(USER_NOT_LICENSED);
  });

  it('other licence errors keep the tenant wording', () => {
    const err = new ApiError(403, 'Forbidden', 'Tenant does not have a SPO license.');
    expect(errorHint(err, 'graph', delegated, { licences: ['sharepoint'] } as never)).toMatchObject({
      licence: true,
      hint: expect.stringContaining("Your tenant's licences don't include this feature."),
    });
  });

  it('usage reports not collected yet: the hint says when they start, not that the tenant lacks a licence', () => {
    const err = new ApiError(404, 'UnknownTenantId', 'We do not recognize this tenant ID.');
    const h = errorHint(err, 'graph', delegated, { licences: ['sharepoint'] } as never);
    expect(h).toMatchObject({ licence: true, message: USAGE_REPORTS_UNAVAILABLE });
    expect(h.hint).toContain('24–48 hours');
    expect(h.hint).not.toMatch(/tenant's licences don't include/);
  });
});
