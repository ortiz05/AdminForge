import { entraConfig, mockConfig } from './helpers';
import { buildTestApp } from './support/app';

// Which network the schedules module hands the probes (security plan S-24, functionality plan F-20). HTTP probes pin
// their connection only when their fetch is the platform fetch (probes/checks.ts `httpTransport`), so the live wiring
// must keep it — a wrapper around it would silently switch pinning off — and use the system resolver and TLS. In
// fixtures mode the probes get the fixture network instead and never touch the network.

async function probeDeps(config: ReturnType<typeof mockConfig>) {
  // `fetch: undefined`: the context falls back to the platform fetch, as in production.
  const { app } = await buildTestApp(config, { deps: { fetch: undefined, schedules: { inProcess: false } } });
  await app.ready();
  return { app, deps: app.schedules.probeDeps };
}

describe('probe network wiring', () => {
  it('live: the platform fetch itself (so HTTP probes are pinned), the system resolver and TLS', async () => {
    const { app, deps } = await probeDeps(entraConfig());
    try {
      expect(deps.fetch).toBe(globalThis.fetch);
      expect(deps.lookup).toBeUndefined();
      expect(deps.connectLookup).toBeUndefined();
      expect(deps.dns).toBeUndefined();
      expect(deps.tls).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('fixtures: the fixture network for fetch, lookup, DNS and TLS', async () => {
    for (const config of [mockConfig(), entraConfig({ DATA_MODE: 'fixtures' })]) {
      const { app, deps } = await probeDeps(config);
      try {
        expect(deps.fetch).not.toBe(globalThis.fetch);
        expect(deps.lookup).toBeTypeOf('function');
        expect(deps.dns?.resolve).toBeTypeOf('function');
        expect(deps.tls?.inspect).toBeTypeOf('function');
      } finally {
        await app.close();
      }
    }
  });
});
