import { useEffect, useState, type PointerEvent } from 'react';

/** What DataTable measures in the browser: text cut off in a header or cell, and columns wider than the table. */

const CLIPPABLE = '[data-af-clip], .truncate';

/**
 * Header and cell text that is cut off (`truncate`, or a `data-af-clip` line clamp) gets its full text as a tooltip
 * when the pointer reaches it — measured then, so text that fits carries no redundant title. Only titles set here
 * are touched (`data-af-title`); a cell's own title (a timestamp, an id) stays. Mouse only: keyboard and touch users
 * read the full text in the row's inspector, and screen readers get it from the DOM.
 */
export function titleIfClipped(e: PointerEvent<HTMLElement>) {
  const target = e.target as HTMLElement;
  const el =
    target.closest<HTMLElement>(CLIPPABLE) ??
    target.closest('[role="columnheader"], [role="gridcell"]')?.querySelector<HTMLElement>(CLIPPABLE);
  if (!el || (el.title && el.dataset.afTitle === undefined)) return;
  if (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight) {
    el.title = el.textContent ?? '';
    el.dataset.afTitle = '';
  } else {
    el.removeAttribute('title');
    delete el.dataset.afTitle;
  }
}

/**
 * Whether the columns are wider than the table's box, so they scroll sideways (a laptop with many columns, a phone).
 * Measured on mount, when the column layout changes and whenever the box or its content resizes.
 */
export function useOverflowsX(el: HTMLElement | null, layout: string): boolean {
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    if (!el) return;
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [el, layout]);
  return overflows;
}
