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

// Each test is a fresh tab: per-tab state (the automatic sign-in guard, lib/sign-in-guard.ts) starts empty.
if (typeof window !== 'undefined') beforeEach(() => window.sessionStorage.clear());

// Component suites share the machine with the api/unit projects; the 1 s Testing Library default for findBy/waitFor
// is too tight under full parallel load. Real regressions still fail (they never appear at all).
import { configure } from '@testing-library/react';
configure({ asyncUtilTimeout: 10_000 });
