/**
 * A scriptable EventSource for jsdom (which has none). Tests push messages with `emit` — with or without an id, and
 * as default `message` events (the API's envelope) or named events.
 */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static last(urlPart: string): FakeEventSource | undefined {
    return [...FakeEventSource.instances]
      .reverse()
      .find((s) => s.url.includes(urlPart) && s.readyState !== 2);
  }

  readonly url: string;
  readyState = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState === 2) return;
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    });
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.get(type)?.delete(fn);
  }

  close() {
    this.readyState = 2;
  }

  emit(data: unknown, opts: { event?: string; id?: string } = {}) {
    if (this.readyState === 2) return;
    const type = opts.event ?? 'message';
    const e = new MessageEvent(type, {
      data: typeof data === 'string' ? data : JSON.stringify(data),
      lastEventId: opts.id ?? '',
    });
    if (type === 'message') this.onmessage?.(e);
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}
