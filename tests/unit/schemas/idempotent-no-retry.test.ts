import { Playbook } from '@adminforge/schemas';

// A step marked `idempotent: false` is sent at most once whenever its outcome is unknown (the HTTP client's
// `sendOnce`); a `retry:` policy would have the engine send it again after a server error or a network failure, so
// validate refuses the two together (security review of the platform-review fixes).

const parse = (step: Record<string, unknown>) =>
  Playbook.safeParse({
    kind: 'playbook',
    id: 'test.once',
    version: '1.0.0',
    title: 'Once',
    owner: 'tests',
    risk: 'low',
    mode: 'write',
    steps: [
      {
        id: 'logOff',
        type: 'arm',
        mode: 'write',
        describe: 'Sign out',
        request: { method: 'DELETE', path: '/subscriptions/s/x', apiVersion: '2024-04-03' },
        ...step,
      },
    ],
  });

describe('idempotent: false with a retry policy', () => {
  it('is refused, on the retry', () => {
    const r = parse({ idempotent: false, retry: { max: 2 } });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      [
        'steps.0.retry',
        'A step marked idempotent: false is never sent twice: remove retry (or idempotent: false, if a second send is harmless).',
      ],
    ]);
  });

  it('either one alone is fine', () => {
    expect(parse({ idempotent: false }).success).toBe(true);
    expect(parse({ retry: { max: 2 } }).success).toBe(true);
  });
});
