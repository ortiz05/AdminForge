import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '@adminforge/api/src/app';
import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { MemoryPreauthStore } from '@adminforge/api/src/auth/preauth-store';
import { MemorySessionStore, type SessionRecord } from '@adminforge/api/src/auth/session-store';
import { createTokenCache, MemorySealedBlobStore } from '@adminforge/api/src/auth/token-cache';
import { registryFrom } from '@adminforge/api/src/definitions/registry';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall } from '@adminforge/api/src/execution/types';
import { MemoryPrefsStore } from '@adminforge/api/src/prefs/prefs-store';
import type { SchedulesOptions } from '@adminforge/api/src/schedules/module';
import { FakeClock, FakeDefinitions, FakeJobs } from '../unit/scheduler/helpers';
import { mockConfig, noNetwork, TEST_KEY } from './helpers';

export { FakeDefinitions, FakeJobs, probe, schedule } from '../unit/scheduler/helpers';

// Synthetic people (never a real tenant).
export const AVERY = { oid: '00000000-0000-4000-8000-0000000000a1', upn: 'avery@example.com' };
export const BLAKE = { oid: '00000000-0000-4000-8000-0000000000b2', upn: 'blake@example.com' };
export const READER = { oid: '00000000-0000-4000-8000-0000000000c3', upn: 'casey@example.com' };
export const ALL_ROLES = ['Portal.Reader', 'Portal.Operator', 'Playbook.Author', 'Playbook.Approver', 'Portal.Admin'];

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class FakeOutbound implements OutboundExecutor {
  readonly calls: Array<{ identity: ExecutionIdentity; call: ServiceCall }> = [];
  constructor(public respond: (call: ServiceCall) => unknown = () => ({})) {}
  async execute<T>(identity: ExecutionIdentity, call: ServiceCall) {
    this.calls.push({ identity, call });
    const data = (await this.respond(call)) as T;
    return { data, status: 200, provenance: { service: call.service, path: call.pathTemplate ?? call.path, ms: 4, requestId: 'req-1' } };
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
  const sessions = new MemorySessionStore();
  const audit = new MemoryAuditWriter(clock.now);
  const app = await buildApp(mockConfig({ ADMINFORGE_ARTIFACTS_DIR: artifactsDir, ...o.config }), {
    database: null,
    now: clock.now,
    sessions,
    preauth: new MemoryPreauthStore(),
    audit,
    prefs: new MemoryPrefsStore(),
    tokenCache: createTokenCache(new MemorySealedBlobStore(), Buffer.from(TEST_KEY, 'base64')),
    fetch: noNetwork,
    definitions: registryFrom(defs as never, 'fs'),
    outbound,
    schedules: { inProcess: o.inProcess ?? false, jobs, timers: clock, ...o.schedules },
  });
  await app.ready();

  let n = 0;
  async function login(user: { oid: string; upn: string }, roles: string[]) {
    const sid = `sid-${++n}-${user.oid}`;
    const now = clock.now();
    const record: SessionRecord = {
      idHash: sha(sid),
      userOid: user.oid,
      upn: user.upn,
      displayName: user.upn,
      tenantId: '00000000-0000-4000-8000-00000000e0e0',
      tenantName: 'Example Org',
      tenantDomain: 'example.com',
      roles,
      csrf: `csrf-${n}`,
      readAccountId: 'mock-read',
      writeAccountId: null,
      writeExpiresAt: null,
      writeExtended: false,
      writeReason: null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 12 * 3_600_000),
      ip: '127.0.0.1',
      userAgent: 'vitest',
    };
    await sessions.create(record);
    const headers = { cookie: `adminforge-dev=${sid}`, 'x-adminforge-csrf': record.csrf };
    return {
      record,
      headers,
      get: (url: string) => app.inject({ method: 'GET', url, headers }),
      post: (url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, headers, payload: payload as Record<string, unknown> }),
      patch: (url: string, payload: unknown) => app.inject({ method: 'PATCH', url, headers, payload: payload as Record<string, unknown> }),
    };
  }

  return {
    app,
    clock,
    defs,
    jobs,
    outbound,
    audit,
    artifactsDir,
    schedules: app.schedules,
    login,
    close: async () => {
      await app.close();
      rmSync(artifactsDir, { recursive: true, force: true });
    },
  };
}
