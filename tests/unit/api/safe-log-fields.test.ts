import { safeLogFields } from '@adminforge/api/src/logging';

// The run worker and scheduler write their own JSON lines; errors there must not carry bound query parameters
// (CSRF tokens, PKCE verifiers, run inputs) either.
describe('safeLogFields (worker and scheduler logs)', () => {
  it('serializes err/error without query params and keeps other fields', () => {
    const dbError = Object.assign(
      new Error('Failed query: select * from sessions where csrf = $1\nparams: s3cret-csrf'),
      {
        params: ['s3cret-csrf'],
        code: '23505',
      },
    );
    const out = safeLogFields({ err: dbError, error: dbError, runId: 'r1' });
    const text = JSON.stringify(out);
    expect(text).not.toContain('s3cret-csrf');
    expect(out.runId).toBe('r1');
    expect((out.err as { message: string }).message).toContain('Failed query');
  });
});
