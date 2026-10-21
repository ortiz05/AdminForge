/**
 * F-08 cases shared by runs-per-user-cap.test.ts (memory) and runs-per-user-cap-db.test.ts (SQLite): one person has
 * at most RUN_MAX_OPEN_PER_USER (default 5) open runs — root runs they started from the portal that are queued or
 * running, previews included. A bulk run counts once (its item runs not at all); runs parked on an approval, input,
 * write access or a sign-in don't count, nor do finished or scheduled runs. Over the cap: 429 `too_many_runs`.
 * Other people are unaffected. The worker is off, so runs stay queued unless a test moves them.
 */
import { randomUUID } from 'node:crypto';
import type { RunStatus } from '@adminforge/engine';
import type { NewRun, RunRepository } from '@adminforge/api/src/runs';
import type { App, TestSession } from './support/app';
import { AVERY, BLAKE, StaticDefinitions } from './runs-helpers';

export const OPERATOR = ['Portal.Reader', 'Portal.Operator'];

export const capDefinitions = () =>
  new StaticDefinitions().add({
    kind: 'playbook',
    id: 'test.cap',
    version: '1.0.0',
    title: 'Cap test',
    owner: 'tests',
    risk: 'low',
    mode: 'write',
    steps: [
      {
        id: 'patch',
        type: 'graph',
        mode: 'write',
        describe: 'Patch',
        request: { method: 'PATCH', path: '/me', body: { a: 1 } },
      },
    ],
  } as never);

export interface CapApp {
  app: App;
  repository: RunRepository;
  login(user: typeof AVERY, roles: string[], opts?: { armed?: boolean }): Promise<TestSession>;
  close(): Promise<void>;
}

/** A run row as another path would write it (child runs, scheduled runs). */
const row = (over: Partial<NewRun>): NewRun => ({
  id: randomUUID(),
  kind: 'playbook',
  definitionKey: 'test.cap',
  definitionVersion: '1.0.0',
  definitionSha256: 'a'.repeat(64),
  dryRun: false,
  trigger: 'interactive',
  identity: 'delegated',
  identityName: null,
  initiatorOid: AVERY.oid,
  initiatorUpn: AVERY.upn,
  sessionHash: null,
  scheduleId: null,
  parentRunId: null,
  inputs: {},
  correlationId: randomUUID(),
  ...over,
});

const start = (s: TestSession, dryRun = false) =>
  s.post('/api/runs', { playbook: 'test.cap', inputs: {}, dryRun });

export function capCases(make: (env?: Record<string, string>) => Promise<CapApp>) {
  let t: CapApp;
  afterEach(async () => {
    await t?.close();
  });

  it('the sixth open run of one person is refused (previews count); other people are unaffected', async () => {
    t = await make();
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    for (const dryRun of [false, false, false, true, true])
      expect((await start(avery, dryRun)).statusCode).toBe(202);
    for (const dryRun of [false, true]) {
      const refused = await start(avery, dryRun);
      expect(refused.statusCode).toBe(429);
      const { error } = refused.json() as { error: { code: string; message: string; hint: string } };
      expect(error.code).toBe('too_many_runs');
      expect(error.message).toBe(
        'You already have 5 runs queued or running, the most one person can have at once.',
      );
      expect(error.hint).toMatch(/Wait for one to finish, or cancel one you don’t need/);
    }
    const blake = await t.login(BLAKE, OPERATOR, { armed: true });
    expect((await start(blake)).statusCode).toBe(202);
    expect((await avery.get('/api/runs?scope=mine&status=active')).json().items).toHaveLength(5);
  });

  it('runs parked on a person, and finished runs, do not count; running ones do', async () => {
    t = await make();
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await start(avery)).json().runId);
    const statuses: RunStatus[] = [
      'awaiting_approval',
      'awaiting_arm',
      'awaiting_input',
      'succeeded',
      'running',
    ];
    for (const [i, status] of statuses.entries()) await t.repository.updateRun(ids[i]!, { status });
    // Open now: one running. Four more fit.
    for (let i = 0; i < 4; i++) expect((await start(avery)).statusCode).toBe(202);
    expect((await start(avery)).statusCode).toBe(429);
  });

  it('a bulk run counts once, and its item runs not at all', async () => {
    t = await make();
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    const bulk = await avery.post('/api/runs/bulk', { playbook: 'test.cap', items: [{}, {}, {}] });
    expect(bulk.statusCode).toBe(202);
    const parent = bulk.json().runId as string;
    await t.repository.updateRun(parent, { status: 'running' });
    for (let i = 0; i < 3; i++)
      await t.repository.insertRun(row({ trigger: 'child', parentRunId: parent, status: 'running' }));
    for (let i = 0; i < 4; i++) expect((await start(avery)).statusCode).toBe(202);
    expect((await start(avery)).statusCode).toBe(429);
  });

  it('scheduled runs do not count towards the person who pressed Run now', async () => {
    t = await make();
    for (let i = 0; i < 5; i++)
      await t.repository.insertRun(
        row({ trigger: 'schedule', identity: 'automation', status: 'running', initiatorUpn: AVERY.upn }),
      );
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    for (let i = 0; i < 5; i++) expect((await start(avery)).statusCode).toBe(202);
    expect((await start(avery)).statusCode).toBe(429);
  });

  it('RUN_MAX_OPEN_PER_USER sets the cap', async () => {
    t = await make({ RUN_MAX_OPEN_PER_USER: '2' });
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    expect((await start(avery)).statusCode).toBe(202);
    expect((await start(avery, true)).statusCode).toBe(202);
    const refused = await start(avery);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.message).toMatch(/^You already have 2 runs queued or running/);
  });

  it('starts at the same moment cannot pass the cap together', async () => {
    t = await make();
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    const codes = (await Promise.all(Array.from({ length: 10 }, () => start(avery)))).map(
      (r) => r.statusCode,
    );
    expect(codes.filter((c) => c === 202)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(5);
    expect(await t.repository.listRuns({ initiatorOid: AVERY.oid, limit: 50 })).toHaveLength(5);
  });
}
