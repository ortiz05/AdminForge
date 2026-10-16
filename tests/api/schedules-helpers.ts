/**
 * The schedules harness: `schedulesApp` builds the API (support/app.ts) with fake content (`FakeDefinitions` through
 * the fs registry), a fake job runner (`FakeJobs`), a recording outbound executor (`FakeOutbound`), a temporary
 * artifacts directory and a `FakeClock` that also drives the scheduler's timers when it runs in-process
 * (`inProcess: true`). `login(person, roles)` signs people in (support/app.ts `sessionFor`); `close()` removes the
 * artifacts directory.
 *
 * Used by the schedules*, probes, news, emergency, artifact, query and schedule-editor route tests, and by
 * portal-schedules-helpers.ts. The scheduler fakes come from tests/support/scheduler.ts and the people from
 * support/people.ts (both re-exported here).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registryFrom } from '@adminforge/api/src/definitions/registry';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall } from '@adminforge/api/src/execution/types';
import type { SchedulesOptions } from '@adminforge/api/src/schedules/module';
import { FakeClock, FakeDefinitions, FakeJobs } from '../support/scheduler';
import { mockConfig } from './helpers';
import { buildTestApp, sessionFor } from './support/app';
import type { TestPerson } from './support/people';

export { FakeDefinitions, FakeJobs, probe, schedule } from '../support/scheduler';
export { ALL_ROLES, AVERY, BLAKE, READER } from './support/people';

export class FakeOutbound implements OutboundExecutor {
  readonly calls: Array<{ identity: ExecutionIdentity; call: ServiceCall }> = [];
  constructor(public respond: (call: ServiceCall) => unknown = () => ({})) {}
  async execute<T>(identity: ExecutionIdentity, call: ServiceCall) {
    this.calls.push({ identity, call });
    const data = (await this.respond(call)) as T;
    return {
      data,
      status: 200,
      provenance: { service: call.service, path: call.pathTemplate ?? call.path, ms: 4, requestId: 'req-1' },
    };
  }
}

export interface SchedulesAppOptions {
  defs?: FakeDefinitions;
  jobs?: FakeJobs;
  outbound?: FakeOutbound;
  inProcess?: boolean;
  config?: Record<string, string>;
  schedules?: Partial<SchedulesOptions>;
}

/** The API on in-memory stores with fake content, a fake job runner and (optionally) the scheduler in-process. */
export async function schedulesApp(o: SchedulesAppOptions = {}) {
  const clock = new FakeClock();
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'af-api-artifacts-'));
  const defs = o.defs ?? new FakeDefinitions();
  const jobs = o.jobs ?? new FakeJobs();
  const outbound = o.outbound ?? new FakeOutbound();
  const { app, sessions, audit } = await buildTestApp(
    mockConfig({ ADMINFORGE_ARTIFACTS_DIR: artifactsDir, ...o.config }),
    {
      clock,
      deps: {
        definitions: registryFrom(defs as never, 'fs'),
        outbound,
        schedules: { inProcess: o.inProcess ?? false, jobs, timers: clock, ...o.schedules },
      },
    },
  );
  await app.ready();

  return {
    app,
    clock,
    defs,
    jobs,
    outbound,
    audit,
    artifactsDir,
    schedules: app.schedules,
    /** Creates a session for a synthetic user and returns request headers and helpers for it. */
    login: (user: TestPerson, roles: string[], opts: { armed?: boolean } = {}) =>
      sessionFor({ app, sessions, clock }, user, roles, opts),
    close: async () => {
      await app.close();
      rmSync(artifactsDir, { recursive: true, force: true });
    },
  };
}
