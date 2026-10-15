import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLiveUpdates } from '@adminforge/web/src/app/live-updates';

// Publishing content or arming in another tab updates this one through /api/events (no reload needed).
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, l: (e: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(l);
  }
  removeEventListener(type: string, l: (e: MessageEvent) => void) {
    this.listeners.get(type)?.delete(l);
  }
  close() {}
  emit(type: string, data: unknown) {
    for (const l of this.listeners.get(type) ?? []) l(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

function Probe() {
  useLiveUpdates();
  return null;
}

describe('useLiveUpdates', () => {
  beforeEach(() => vi.stubGlobal('EventSource', FakeEventSource));
  afterEach(() => vi.unstubAllGlobals());

  it('refetches content queries on definitions.changed and the session on session.mode', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const view = render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    act(() => FakeEventSource.last!.emit('definitions.changed', { keys: ['page:identity.users'] }));
    const keys = invalidate.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
    expect(keys).toEqual(
      expect.arrayContaining(['["definition"]', '["nav"]', '["schedules"]', '["overview"]']),
    );
    invalidate.mockClear();
    act(() => FakeEventSource.last!.emit('session.mode', { mode: 'armed' }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me'] });
    view.unmount();
  });
});
