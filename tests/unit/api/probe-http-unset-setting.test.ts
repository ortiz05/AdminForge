import { runProbe, type ProbeDeps } from '@adminforge/api/src/probes/checks';
import type { OutboundExecutor } from '@adminforge/api/src/execution/types';
import { Probe } from '@adminforge/schemas';

// An HTTP probe whose URL is built from a setting the installation doesn't have (the SharePoint front door without
// AF_SPO_TENANT_NAME) says "not configured", naming the key — not the raw expression error — and fetches nothing.
// A URL that falls back to another key (Autodiscover: the mail domain, else the primary domain) still runs.
const probe = (url: string) =>
  Probe.parse({
    kind: 'probe',
    id: 'probes.front-door',
    version: '1.0.0',
    title: 'Front door',
    owner: 'test',
    check: { kind: 'http', url, expect: { status: [401, 403] } },
  });

function deps(env: Record<string, string | undefined>) {
  const fetched: string[] = [];
  const d: ProbeDeps = {
    outbound: {} as OutboundExecutor,
    automation: null,
    connection: async () => {
      throw new Error('no connections');
    },
    env: () => env,
    now: () => new Date('2026-10-17T12:00:00.000Z'),
    fetch: async (url) => {
      fetched.push(String(url));
      return new Response('', { status: 401 });
    },
    lookup: async () => ['93.184.216.34'],
  };
  return { d, fetched };
}

const spo = "${ 'https://' & $encode(env.AF_SPO_TENANT_NAME) & '.sharepoint.com/_api/web' }";
const autodiscover =
  "${ 'https://outlook.office365.com/autodiscover/autodiscover.json/v1.0/' & $encode('x@' & (env.AF_MAIL_DOMAIN ? env.AF_MAIL_DOMAIN : env.AF_PRIMARY_DOMAIN)) }";

describe('HTTP probes on a setting that is not set', () => {
  it('names the missing key instead of the expression error', async () => {
    const { d, fetched } = deps({});
    const out = await runProbe('probes.front-door', probe(spo), d);
    expect(out).toMatchObject({ status: 'error', code: 'not_configured' });
    expect(out.message).toMatch(/^AF_SPO_TENANT_NAME is not set, so this check has nothing to look at\./);
    expect(out.message).not.toMatch(/expression|\$encode/);
    expect(fetched).toEqual([]);
  });

  it('runs once the key is set', async () => {
    const { d, fetched } = deps({ AF_SPO_TENANT_NAME: 'example' });
    const out = await runProbe('probes.front-door', probe(spo), d);
    expect(out.status).toBe('ok');
    expect(fetched).toEqual(['https://example.sharepoint.com/_api/web']);
  });

  it('runs a URL that falls back to another key', async () => {
    const { d, fetched } = deps({ AF_PRIMARY_DOMAIN: 'example.onmicrosoft.com' });
    await runProbe('probes.front-door', probe(autodiscover), d);
    expect(fetched).toEqual([
      'https://outlook.office365.com/autodiscover/autodiscover.json/v1.0/x%40example.onmicrosoft.com',
    ]);
  });
});
