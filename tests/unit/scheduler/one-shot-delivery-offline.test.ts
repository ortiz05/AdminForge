import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { loadConfig } from '@adminforge/api/src/config';
import { openOneShot } from '@adminforge/scheduler/one-shot';

// DATA_MODE=fixtures never touches the network (F-20). A one-shot's delivery override (`env`: what `${ env.X }`
// recipients and webhooks resolve to) also set `fetch` to the platform fetch, replacing the schedules module's fixture
// fetch, so a one-shot on fixtures posted its Teams messages to the internet. The override now leaves `fetch` alone.

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const WEBHOOK = 'https://example.webhook.office.com/webhookb2/00000000-0000-4000-8000-0000000000f3';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('scheduler one-shot: delivery in fixtures mode never touches the network', () => {
  let dir: string;
  const platform: string[] = [];
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'af-one-shot-offline-'));
    const write = (rel: string, text: string) => {
      mkdirSync(path.dirname(path.join(dir, 'content', rel)), { recursive: true });
      writeFileSync(path.join(dir, 'content', rel), text);
    };
    write(
      'probes/audit-chain.probe.yaml',
      'kind: probe\nid: probes.audit-chain\nversion: 1.0.0\ntitle: Audit chain\nowner: test-team\ncheck:\n  kind: auditChain\n',
    );
    write(
      'schedules/audit-chain.schedule.yaml',
      [
        'kind: schedule',
        'id: schedules.audit-chain',
        'version: 1.0.0',
        'title: Audit chain',
        'owner: test-team',
        'cron: "0 * * * *"',
        'job:',
        '  kind: probe',
        '  ref: probes.audit-chain',
        'notify:',
        '  onSuccess:',
        '    - type: teams',
        "      webhook: '${ env.AF_TEAMS_ALERTS_WEBHOOK }'",
        '',
      ].join('\n'),
    );
    platform.length = 0;
    vi.stubGlobal('fetch', async (input: unknown) => {
      platform.push(String(input instanceof Request ? input.url : input));
      throw new TypeError('fetch failed: the network is off in this test');
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it("posts a schedule's Teams notification through the fixtures when the override only sets env", async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://localhost:5173',
      AUTH_MODE: 'mock',
      DATA_MODE: 'fixtures',
      ADMINFORGE_FIXTURES_DIR: FIXTURES,
      CONTENT_DIR: path.join(dir, 'content'),
      CONTENT_WATCH: 'false',
      ADMINFORGE_ARTIFACTS_DIR: path.join(dir, 'artifacts'),
    });
    const oneShot = openOneShot(config, {
      log: silent,
      noStore: true,
      delivery: { env: { AF_TEAMS_ALERTS_WEBHOOK: WEBHOOK } },
    });
    try {
      const run = await oneShot.runSchedule('schedules.audit-chain', 'test:operator');
      expect(run.status).toBe('succeeded');
      const notified = (oneShot.ctx.audit as MemoryAuditWriter).rows.filter(
        (r) => r.action === 'schedule.notified',
      );
      expect(notified.map((r) => [r.result, r.details])).toEqual([
        ['success', { results: [{ type: 'teams', status: 'sent', message: 'Posted to Teams.' }] }],
      ]);
      expect(platform).toEqual([]);
    } finally {
      await oneShot.close();
    }
  });

  it('keeps a fetch the override names (the live script refuses Teams with its own)', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://localhost:5173',
      AUTH_MODE: 'mock',
      DATA_MODE: 'fixtures',
      ADMINFORGE_FIXTURES_DIR: FIXTURES,
      CONTENT_DIR: path.join(dir, 'content'),
      CONTENT_WATCH: 'false',
      ADMINFORGE_ARTIFACTS_DIR: path.join(dir, 'artifacts'),
    });
    const refused: string[] = [];
    const oneShot = openOneShot(config, {
      log: silent,
      noStore: true,
      delivery: {
        env: { AF_TEAMS_ALERTS_WEBHOOK: WEBHOOK },
        fetch: (async (input: unknown) => {
          refused.push(String(input));
          throw new Error('Teams delivery is suppressed');
        }) as typeof fetch,
      },
    });
    try {
      await oneShot.runSchedule('schedules.audit-chain', 'test:operator');
      expect(refused).toEqual([WEBHOOK]);
      expect(platform).toEqual([]);
    } finally {
      await oneShot.close();
    }
  });
});
