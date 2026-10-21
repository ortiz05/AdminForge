import { abortableDelay } from '@adminforge/connectors';

// The real-timer wait that stops when its signal aborts (organization review O-07): the scheduled jobs' and the
// synthetic transaction probes' default sleep, which each kept a copy. It clears its timer on abort, so a stopping
// process isn't held open by a wait nobody needs, and leaves no listener on the signal once it resolves.
describe('abortableDelay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the wait', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = abortableDelay(2_000, new AbortController().signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });

  it('resolves without a signal', async () => {
    await expect(abortableDelay(1)).resolves.toBeUndefined();
  });

  it('rejects at once with the reason of a signal that already aborted, starting no timer', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const reason = new Error('shutting down');
    ac.abort(reason);
    await expect(abortableDelay(60_000, ac.signal)).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with the reason as soon as the signal aborts, and clears its timer', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = abortableDelay(60_000, ac.signal);
    expect(vi.getTimerCount()).toBe(1);
    const reason = new Error('stopped');
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes its abort listener once it resolves', async () => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    const add = vi.spyOn(signal, 'addEventListener');
    const remove = vi.spyOn(signal, 'removeEventListener');
    const p = abortableDelay(10, signal);
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
  });
});
