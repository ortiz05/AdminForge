import '@testing-library/jest-dom/vitest';

// jsdom gaps that Radix, cmdk and TanStack Virtual rely on. Test-only shims; runtime code never sees them.

class ResizeObserverShim {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverShim as unknown as typeof ResizeObserver;

if (typeof window !== 'undefined') {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;

  const proto = window.HTMLElement.prototype as HTMLElement & Record<string, unknown>;
  proto.scrollIntoView ??= function scrollIntoView() {};
  proto.hasPointerCapture ??= function hasPointerCapture() {
    return false;
  };
  proto.releasePointerCapture ??= function releasePointerCapture() {};
  proto.setPointerCapture ??= function setPointerCapture() {};
}
