import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

/** Current time, refreshed every `intervalMs` (relative times, countdowns). */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function subscribeHtml(attribute: string) {
  return (onChange: () => void) => {
    if (typeof MutationObserver === 'undefined') return () => {};
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [attribute] });
    return () => observer.disconnect();
  };
}

/** Live value of an attribute on <html> (data-theme, data-density, data-mode). */
export function useHtmlAttribute(attribute: string): string | null {
  const subscribe = useMemo(() => subscribeHtml(attribute), [attribute]);
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.getAttribute(attribute),
    () => null,
  );
}

/** Reads a length custom property (e.g. --af-table-row-h) in px, re-reading when density changes. */
export function useCssVarPx(name: string, fallback: number, element?: HTMLElement | null): number {
  const density = useHtmlAttribute('data-density');
  return useMemo(() => {
    if (typeof document === 'undefined') return fallback;
    const value = parseFloat(getComputedStyle(element ?? document.documentElement).getPropertyValue(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
    // `density` is the trigger: the variable's value changes with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, fallback, element, density]);
}

/** Matches a media query (prefers-reduced-motion, prefers-color-scheme). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** Copies text, reporting success for 1.2 s. Clipboard can be unavailable (non-secure origin): fail quietly. */
export function useCopy(): [copied: boolean, copy: (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(id);
  }, [copied]);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return [copied, copy];
}
