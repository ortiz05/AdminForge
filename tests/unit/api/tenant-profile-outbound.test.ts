import { tenantProfile } from '@adminforge/api/src/auth/routes';
import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall } from '@adminforge/api/src/execution/types';

// S-26: the tenant name and default domain shown in the shell are read at sign-in. That read used a Graph client of
// its own, outside the outbound executor (no request policy, no concurrency slot, no `microsoft call` line). It goes
// through the executor now, as the person signing in (their Read app), and still never blocks the sign-in.

const signingIn = { idHash: 'sid-hash', userOid: '00000000-0000-4000-8000-0000000000c0' } as SessionRecord;
const config = { AF_PRIMARY_DOMAIN: 'example.com' } as never;
const auth = {} as never;

interface Seen {
  identity: ExecutionIdentity;
  call: ServiceCall;
  opts: { correlationId?: string; signal?: AbortSignal } | undefined;
}

function outbound(answer: (signal?: AbortSignal) => Promise<unknown>): OutboundExecutor & { seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    async execute(identity, call, opts) {
      seen.push({ identity, call, opts });
      return { data: await answer(opts?.signal), status: 200, provenance: null } as never;
    },
  };
}

const org = {
  value: [
    {
      displayName: 'Example Org',
      verifiedDomains: [{ name: 'example.onmicrosoft.com' }, { name: 'example.com', isDefault: true }],
    },
  ],
};

describe('tenantProfile', () => {
  it('reads /organization through the outbound executor, as the person signing in (read mode)', async () => {
    const out = outbound(async () => org);
    const profile = await tenantProfile({ config, auth, outbound: out }, signingIn, 'corr-signin');
    expect(profile).toEqual({ name: 'Example Org', domain: 'example.com' });
    expect(out.seen).toHaveLength(1);
    const [{ identity, call, opts }] = out.seen as [Seen];
    expect(identity).toEqual({ kind: 'delegated', session: signingIn, mode: 'read' });
    expect(call).toEqual({
      service: 'graph',
      method: 'GET',
      path: '/organization',
      query: { $select: 'displayName,verifiedDomains' },
      maxRetries: 0,
    });
    expect(call.declaredWrite).toBeUndefined();
    expect(opts?.correlationId).toBe('corr-signin');
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it('falls back to AF_PRIMARY_DOMAIN when the read fails (never blocks sign-in)', async () => {
    const out = outbound(async () => {
      throw new Error('Graph is down');
    });
    await expect(tenantProfile({ config, auth, outbound: out }, signingIn, 'c')).resolves.toEqual({
      name: 'example.com',
      domain: 'example.com',
    });
  });

  it('gives up after its time limit (the executor sees the abort)', async () => {
    let aborted = false;
    const out = outbound(
      (signal) =>
        new Promise((_, reject) =>
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(signal.reason);
          }),
        ),
    );
    const started = Date.now();
    const profile = await tenantProfile({ config, auth, outbound: out }, signingIn, 'c', 20);
    expect(profile).toEqual({ name: 'example.com', domain: 'example.com' });
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('asks nothing without Entra sign-in', async () => {
    const out = outbound(async () => org);
    await expect(tenantProfile({ config, auth: null, outbound: out }, signingIn, 'c')).resolves.toEqual({
      name: 'example.com',
      domain: 'example.com',
    });
    expect(out.seen).toEqual([]);
  });

  it('keeps the fallback for parts Microsoft leaves out', async () => {
    const out = outbound(async () => ({ value: [{ verifiedDomains: [] }] }));
    await expect(
      tenantProfile(
        { config: { AF_PRIMARY_DOMAIN: undefined } as never, auth, outbound: out },
        signingIn,
        'c',
      ),
    ).resolves.toEqual({ name: 'Microsoft Entra tenant', domain: '' });
  });
});
