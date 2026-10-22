import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import type { RunnerExec } from '@adminforge/api/src/datasources/executor';
import { perPersonLimit } from '@adminforge/api/src/datasources/runner';
import { RunnerSlots } from '@adminforge/api/src/execution/runner-slots';
import type { ExecutionIdentity } from '@adminforge/api/src/execution/types';
import { perPersonRunnerPort } from '@adminforge/api/src/runs/ports';

// The runner has a few PowerShell workers for everyone. One person's pages and exports may hold at most three at once
// (RUNNER_JOBS_PER_PERSON, shared with playbook steps); one more read is refused plainly, a playbook step waits, other people's reads still start, and a slot comes back
// when a read ends, however it ends (2026-10-22 security review). Synthetic ids only.
const person = (oid: string): ExecutionIdentity => ({
  kind: 'delegated',
  session: { userOid: oid, upn: `${oid}@example.com` } as SessionRecord,
  mode: 'read',
});
const AVERY = person('00000000-0000-4000-8000-0000000000a1');
const BLAKE = person('00000000-0000-4000-8000-0000000000b2');
const AUTOMATION: ExecutionIdentity = { kind: 'automation', mode: 'read' };
const job = {
  script: 'exchange/Get-Example.ps1',
  sha256: 'x'.repeat(64),
  parameters: {},
  services: [],
  timeoutSeconds: 60,
  mode: 'read' as const,
};

/** A runner whose jobs finish when the test says so. */
function slowRunner() {
  const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const exec: RunnerExec = {
    run: () =>
      new Promise((resolve, reject) => pending.push({ resolve: () => resolve({ data: [] }), reject })),
  };
  return { exec, pending };
}
const start = (r: RunnerExec, who: ExecutionIdentity) =>
  r.run(who, job, { correlationId: 'c' }).then(
    () => 'done',
    (e: { code?: string; status?: number }) => e,
  );

describe('PowerShell reads per person', () => {
  it('refuses a fourth read while three run, and lets someone else start', async () => {
    const { exec, pending } = slowRunner();
    const limited = perPersonLimit(exec, 3, new RunnerSlots());
    const running = [start(limited, AVERY), start(limited, AVERY), start(limited, AVERY)];
    expect(await start(limited, AVERY)).toMatchObject({ status: 429, code: 'runner_busy_for_you' });
    const other = start(limited, BLAKE);
    expect(pending).toHaveLength(4);
    pending.forEach((p) => p.resolve());
    expect(await Promise.all([...running, other])).toEqual(['done', 'done', 'done', 'done']);
  });

  it('gives the slot back when a read fails', async () => {
    const { exec, pending } = slowRunner();
    const limited = perPersonLimit(exec, 1, new RunnerSlots());
    const first = start(limited, AVERY);
    pending[0]!.reject(new Error('the script failed'));
    expect(await first).toBeInstanceOf(Error);
    const second = start(limited, AVERY);
    pending[1]!.resolve();
    expect(await second).toBe('done');
  });

  it('leaves the automation identity (schedules) to the runner’s own queue', async () => {
    const { exec, pending } = slowRunner();
    const limited = perPersonLimit(exec, 1, new RunnerSlots());
    const runs = [start(limited, AUTOMATION), start(limited, AUTOMATION)];
    expect(pending).toHaveLength(2);
    pending.forEach((p) => p.resolve());
    expect(await Promise.all(runs)).toEqual(['done', 'done']);
  });
});

describe('playbook PowerShell steps share the person’s slots', () => {
  const resolved = (oid: string | null) =>
    ({
      actor: oid
        ? { kind: 'delegated', oid, upn: 'x@example.com' }
        : { kind: 'automation', oid: null, upn: null },
      mode: 'write',
      handle: null,
    }) as never;
  it('waits for one of the person’s own jobs to finish, and a page read is refused meanwhile', async () => {
    const slots = new RunnerSlots();
    const finishes: Array<() => void> = [];
    const port = perPersonRunnerPort(
      {
        run: () => new Promise((resolve) => finishes.push(() => resolve({ status: 'succeeded' } as never))),
      } as never,
      1,
      slots,
    );
    const signal = new AbortController().signal;
    const first = port.run(
      resolved(AVERY.kind === 'delegated' ? AVERY.session.userOid : null),
      {} as never,
      { signal, onEvent: () => {} } as never,
    );
    const second = port.run(
      resolved(AVERY.kind === 'delegated' ? AVERY.session.userOid : null),
      {} as never,
      { signal, onEvent: () => {} } as never,
    );
    await Promise.resolve();
    expect(finishes).toHaveLength(1); // the second step waits
    const page = perPersonLimit(slowRunner().exec, 1, slots);
    expect(await start(page, AVERY)).toMatchObject({ status: 429 });
    finishes[0]!();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(finishes).toHaveLength(2);
    finishes[1]!();
    await second;
  });

  it('gives up waiting when the run is cancelled', async () => {
    const slots = new RunnerSlots();
    const port = perPersonRunnerPort({ run: () => new Promise(() => {}) } as never, 1, slots);
    const oid = '00000000-0000-4000-8000-0000000000c3';
    void port.run(
      resolved(oid),
      {} as never,
      { signal: new AbortController().signal, onEvent: () => {} } as never,
    );
    const stop = new AbortController();
    const waiting = port
      .run(resolved(oid), {} as never, { signal: stop.signal, onEvent: () => {} } as never)
      .then(
        () => 'ran',
        () => 'cancelled',
      );
    stop.abort(new Error('cancelled'));
    expect(await waiting).toBe('cancelled');
  });
});
