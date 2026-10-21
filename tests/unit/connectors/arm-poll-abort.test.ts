import { createArmClient } from '@adminforge/connectors';
import { fakeFetch } from './fake-fetch';

// D-23b: polling an Azure long-running operation slept without the abort signal (up to `maxPollMs`, 30 minutes by
// default), so a stopping pod, a cancelled run or a schedule's timeout couldn't end the wait — the step ran on until
// SIGKILL. The wait between polls now ends as soon as the call is aborted, with the abort's reason.

const SUB = '/subscriptions/00000000-0000-4000-8000-000000000001';
const OP = `https://management.azure.com${SUB}/providers/Microsoft.Web/operations/op1?api-version=2022-03-01`;

describe('ARM long-running operations and abort', () => {
  it('a poll wait ends when the caller aborts, and nothing more is polled', async () => {
    const f = fakeFetch([
      { status: 202, headers: { 'azure-asyncoperation': OP, 'retry-after': '60' } },
      { status: 200, body: { status: 'InProgress' } },
    ]);
    const controller = new AbortController();
    let sleeping!: () => void;
    const asleep = new Promise<void>((r) => (sleeping = r));
    // A sleep that never ends by itself: only the abort can end the wait.
    const sleep = vi.fn(() => {
      sleeping();
      return new Promise<void>(() => undefined);
    });
    const arm = createArmClient({
      getToken: async () => 't',
      fetch: f.fetch,
      sleep,
      signal: controller.signal,
    });
    const done = arm
      .requestAndWait({ method: 'POST', path: `${SUB}/resourceGroups/rg/restart`, apiVersion: '2022-03-01' })
      .then(
        () => 'finished',
        (e: unknown) => e,
      );
    await asleep;
    controller.abort(new Error('run cancelled'));
    await expect(done).resolves.toMatchObject({ message: 'run cancelled' });
    expect(f.calls).toHaveLength(1);
  });

  it('an already aborted call does not start waiting', async () => {
    const f = fakeFetch([{ status: 202, headers: { location: OP } }]);
    const controller = new AbortController();
    const sleep = vi.fn(async () => undefined);
    const arm = createArmClient({
      getToken: async () => 't',
      fetch: f.fetch,
      sleep,
      signal: controller.signal,
    });
    const initial = await arm.request<unknown>({
      method: 'POST',
      path: `${SUB}/resourceGroups/rg/restart`,
      apiVersion: '2022-03-01',
    });
    controller.abort(new Error('pod stopping'));
    await expect(
      arm.waitForCompletion(
        { method: 'POST', path: `${SUB}/resourceGroups/rg/restart`, apiVersion: '2022-03-01' },
        initial,
      ),
    ).rejects.toThrow('pod stopping');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('without a signal, polling works as before', async () => {
    const f = fakeFetch([
      { status: 202, headers: { location: OP } },
      { status: 202 },
      { status: 200, body: { done: true } },
    ]);
    const sleep = vi.fn(async () => undefined);
    const arm = createArmClient({ getToken: async () => 't', fetch: f.fetch, sleep, pollIntervalMs: 10 });
    const r = await arm.requestAndWait({
      method: 'POST',
      path: `${SUB}/resourceGroups/rg/restart`,
      apiVersion: '2022-03-01',
    });
    expect(r.data).toEqual({ done: true });
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
