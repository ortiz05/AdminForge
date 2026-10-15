import { createElement } from 'react';
import type { LinkComponent } from '@adminforge/ui';
import type { ProbesState, WidgetRuntime } from '../types';
import { getPath, splitDataRef } from './path';

const PlainLink: LinkComponent = ({ href, className, children }) => createElement('a', { href, className }, children);

/** `/p/identity.user?id=…` (empty params dropped; objects JSON-encoded). */
export function contentHref(page: string, params: Record<string, unknown> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const s = q.toString();
  return `/p/${page}${s ? `?${s}` : ''}`;
}

const NO_PROBES: ProbesState = { status: 'ready', probes: [] };

/**
 * A self-contained runtime for widgets outside a page (tests, the design page, previews): datasource results come
 * from `data`, actions are no-ops unless overridden.
 */
export function createWidgetRuntime(overrides: Partial<WidgetRuntime> & { data?: Record<string, unknown> } = {}): WidgetRuntime {
  const { data = {}, ...rest } = overrides;
  const scope = rest.scope ?? { params: {}, user: {}, now: new Date().toISOString(), ...data };
  return {
    pageKey: 'preview.widgets',
    scope,
    resolve: (path) => {
      const { root, rest: sub } = splitDataRef(path);
      return getPath(data[root], sub);
    },
    Link: PlainLink,
    navigate: () => {},
    hrefFor: contentHref,
    openPlaybook: () => {},
    tableView: () => undefined,
    feature: () => undefined,
    dataMode: 'live',
    useProbes: () => NO_PROBES,
    ...rest,
  };
}
