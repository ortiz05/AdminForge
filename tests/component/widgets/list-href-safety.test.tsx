import { screen, within } from '@testing-library/react';
import {
  WIDGETS,
  createWidgetRuntime,
  type KpiConfig,
  type ListConfig,
  type StatusGridConfig,
} from '@adminforge/widgets';
import { axeViolations } from '../axe';
import { ready, renderWidget } from './helpers';

// Drill-down hrefs of the list, KPI and status-grid widgets are templates filled from data. Like table row actions and
// keyValue links they follow safeUrl themselves — whatever `runtime.Link` the page gives them: an unsafe target leaves
// the row or figure as plain text, never an anchor (S-11).
const List = WIDGETS.list!.component;
const Kpi = WIDGETS.kpi!.component;
const StatusGrid = WIDGETS.statusGrid!.component;

const UNSAFE = [
  '/\\evil.example.com',
  '//evil.example.com',
  '/\t/evil.example.com',
  'javascript:alert(1)',
  'data:text/html,x',
  'https:///evil.example.com',
  'relative/path',
];
const SAFE = ['/p/security.incident?id=inc-1', 'https://entra.microsoft.com/'];

const rows = (targets: string[]) => targets.map((target, i) => ({ id: `r${i}`, name: `Item ${i}`, target }));

describe('list rows', () => {
  const config = WIDGETS.list!.schema.parse({
    widget: 'list',
    title: 'Incidents',
    data: 'items.value',
    primary: 'name',
    href: '${ row.target }',
    limit: 20,
  }) as ListConfig;

  it('an unsafe target leaves the row as text; safe targets are links', async () => {
    const targets = [...SAFE, ...UNSAFE];
    const { container } = renderWidget(List, config, ready(rows(targets)));
    const list = screen.getByRole('list', { name: 'Incidents' });
    const links = await within(list).findAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(SAFE);
    for (let i = SAFE.length; i < targets.length; i++) {
      const item = within(list).getByText(`Item ${i}`);
      expect(item).toBeVisible();
      expect(item.closest('a')).toBeNull();
    }
    expect(container.querySelectorAll('a')).toHaveLength(SAFE.length);
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('status-grid tiles', () => {
  const config = WIDGETS.statusGrid!.schema.parse({
    widget: 'statusGrid',
    title: 'Connections',
    data: 'items.value',
    label: 'name',
    status: 'state',
    href: '${ row.target }',
  }) as StatusGridConfig;

  it('an unsafe target leaves the tile as text; safe targets are links', async () => {
    const targets = [...SAFE, ...UNSAFE];
    const { container } = renderWidget(StatusGrid, config, ready(rows(targets)));
    const grid = screen.getByRole('list', { name: 'Connections' });
    const links = await within(grid).findAllByRole('link');
    expect(links.map((l) => l.getAttribute('href')).sort()).toEqual([...SAFE].sort());
    expect(container.querySelectorAll('a')).toHaveLength(SAFE.length);
    for (let i = SAFE.length; i < targets.length; i++)
      expect(within(grid).getByText(`Item ${i}`).closest('a')).toBeNull();
  });
});

describe('KPI drill-down', () => {
  const config = WIDGETS.kpi!.schema.parse({
    widget: 'kpi',
    label: 'Risky sign-ins',
    data: 'counts.risky',
    href: '${ params.target }',
  }) as KpiConfig;

  it.each(UNSAFE)('%j: the figure shows, without a link', async (target) => {
    const runtime = createWidgetRuntime({ scope: { params: { target } } });
    const { container } = renderWidget(Kpi, config, ready(7), runtime);
    expect(await screen.findByRole('group', { name: 'Risky sign-ins' })).toHaveTextContent('7');
    // Templates resolve after the first render: give the href its chance to appear.
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('a')).toBeNull();
  });

  it.each(SAFE)('%j is a link', async (target) => {
    const runtime = createWidgetRuntime({ scope: { params: { target } } });
    renderWidget(Kpi, config, ready(7), runtime);
    const link = await screen.findByRole('link', { name: /Risky sign-ins/ });
    expect(link).toHaveAttribute('href', target);
  });
});
