import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@adminforge/api/src/config';
import { openOneShot } from '@adminforge/scheduler/one-shot';

// D-03a: the API process logs one `microsoft call` line per Microsoft call (template path, status, ms, throttling,
// request id) for troubleshooting by Reference. Scheduler one-shots (`adminforge-scheduler --schedule/--probe/--once`)
// passed only a warn logger, so their calls left no trace; they log the same line now.

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));

describe('scheduler one-shot: microsoft call lines', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'af-one-shot-log-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('logs each Microsoft call at info, with the template path and no values', async () => {
    const info: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const log = {
      info: (obj: object, msg: string) => void info.push({ obj: obj as Record<string, unknown>, msg }),
      warn: () => undefined,
      error: () => undefined,
    };
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
    const oneShot = openOneShot(config, { log, noStore: true });
    try {
      await oneShot.ctx.outbound.execute(
        { kind: 'automation', mode: 'read' },
        {
          service: 'graph',
          method: 'GET',
          path: '/organization',
          query: { $select: 'id,displayName' },
        },
        { correlationId: 'corr-one-shot' },
      );
    } finally {
      await oneShot.close();
    }
    const calls = info.filter((l) => l.msg === 'microsoft call');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.obj.call).toMatchObject({
      service: 'graph',
      method: 'GET',
      path: '/organization',
      status: 200,
      identity: 'automation',
      mode: 'read',
      correlationId: 'corr-one-shot',
    });
  });
});
