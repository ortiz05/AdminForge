import { screen, waitFor, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { STATUS_ICON, type StatusTone } from '@adminforge/ui';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import type { MockHandler } from '../../support/web/mock-handler';
import { axeViolations } from '../axe';
import { renderApp } from './automation/render';

// M5: a section's mark in the navigation rail is Synthetic monitoring's status icon at 12 px (so the rail and the page
// read alike); a closed section's page count isn't shown beside it (it read as a count of failures); and a section
// gets no mark until one of its probes has a result (a fresh install showed a ring per section, like radio buttons).

const probe = (key: string, group: string, status: string | null) => ({
  key,
  title: key,
  kind: 'http',
  group,
  latest: status ? { ts: new Date().toISOString(), status, metric: 120, unit: 'ms', message: null } : null,
  series: [],
  thresholds: { warn: 1000, crit: 3000, unit: 'ms' },
});
const GROUPS = [
  { key: 'identity', label: 'Identity', icon: 'identification-card' },
  { key: 'm365', label: 'Microsoft 365', icon: 'squares-four' },
  { key: 'endpoint', label: 'Endpoint', icon: 'devices' },
  { key: 'azure', label: 'Azure', icon: 'cloud' },
];
const answer =
  (items: unknown[]): MockHandler =>
  ({ method, path }) =>
    method === 'GET' && path === '/api/probes' ? { body: { items, groups: GROUPS } } : undefined;

const nav = () => screen.getByRole('navigation', { name: 'Primary' });

/** The path data of a status icon as Synthetic monitoring draws it. */
const iconPaths = (tone: StatusTone) => {
  const Glyph = STATUS_ICON[tone];
  const html = renderToStaticMarkup(<Glyph size={12} weight="fill" />);
  return [...html.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
};
const pathsOf = (el: Element) => [...el.querySelectorAll('path')].map((p) => p.getAttribute('d'));

describe('navigation: section check marks', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });

  it('draws Synthetic monitoring’s status icons at 12 px, coloured by status', async () => {
    renderApp({
      handlers: [
        answer([
          probe('probes.a', 'identity', 'crit'),
          probe('probes.b', 'm365', 'ok'),
          probe('probes.c', 'endpoint', 'warn'),
        ]),
      ],
    });
    await screen.findByRole('navigation', { name: 'Primary' });
    for (const [name, tone, colour] of [
      [/^Identity service checks/, 'crit', 'text-crit'],
      [/^Microsoft 365 service checks/, 'ok', 'text-ok'],
      [/^Endpoint service checks/, 'warn', 'text-warn'],
    ] as const) {
      const link = await within(nav()).findByRole('link', { name });
      const svg = link.querySelector('svg')!;
      expect(svg.getAttribute('width')).toBe('12');
      expect(svg).toHaveClass(colour);
      expect(pathsOf(svg)).toEqual(iconPaths(tone));
    }
    expect(await axeViolations()).toEqual([]);
  });

  it('shows no page count on a closed section, with or without a mark (the name says it)', async () => {
    renderApp({ handlers: [answer([probe('probes.a', 'identity', 'ok')])] });
    await within(await screen.findByRole('navigation', { name: 'Primary' })).findByRole('link', {
      name: 'Identity service checks: 1 healthy',
    });
    const identity = within(nav()).getByRole('button', { name: 'Identity (6 pages hidden)' });
    expect(identity).toHaveTextContent(/^Identity$/);
    // No probes, no mark: still no number (the owner, 2026-10-23: section rows show no counts).
    expect(within(nav()).getByRole('button', { name: 'Microsoft 365 (4 pages hidden)' })).toHaveTextContent(
      /^Microsoft 365$/,
    );
  });

  it('shows no mark until a probe has a result: a fresh install has none', async () => {
    // On Synthetic monitoring (one cache for the page and the rail): once its tiles show, the rail has the answer too.
    renderApp({
      path: '/monitoring',
      handlers: [
        answer([
          probe('probes.a', 'identity', null),
          probe('probes.b', 'm365', null),
          probe('probes.c', 'azure', null),
        ]),
      ],
    });
    await within(await screen.findByRole('main')).findByRole('button', { name: /^probes\.a/ });
    const identity = within(nav()).getByRole('button', { name: 'Identity (6 pages hidden)' });
    await waitFor(() => expect(identity).toHaveTextContent(/^Identity$/));
    expect(within(nav()).queryAllByRole('link', { name: /service checks/ })).toHaveLength(0);
    expect(nav().querySelector('a[href^="/monitoring?group="]')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('marks a section once one of its probes has a result, by the results there are', async () => {
    renderApp({
      handlers: [answer([probe('probes.a', 'azure', null), probe('probes.b', 'azure', 'warn')])],
    });
    await screen.findByRole('navigation', { name: 'Primary' });
    const azure = await within(nav()).findByRole('link', {
      name: 'Azure service checks: 1 degraded, 1 with no result yet',
    });
    expect(azure).toHaveAttribute('data-status', 'warn');
  });
});
