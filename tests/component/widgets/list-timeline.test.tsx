import { screen, within } from '@testing-library/react';
import { FIXTURE_NOW, WIDGETS, listFixtures, timelineFixtures, type ListConfig, type TimelineConfig } from '@adminforge/widgets';
import { axeViolations } from '../axe';
import { failed, ready, renderWidget } from './helpers';

const List = WIDGETS.list!.component;
const Timeline = WIDGETS.timeline!.component;
const listConfig = WIDGETS.list!.schema.parse(listFixtures.incidents.config) as ListConfig;
const timelineConfig = WIDGETS.timeline!.schema.parse(timelineFixtures.audit.config) as TimelineConfig;

// Fixture times are relative to FIXTURE_NOW; fake only the clock (timers and promises stay real).
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: FIXTURE_NOW }));
afterEach(() => vi.useRealTimers());

describe('list widget', () => {
  it('rows show primary, formatted secondary, status (icon + words) and a templated link', async () => {
    const { container } = renderWidget(List, listConfig, ready(listFixtures.incidents.rows));
    const list = screen.getByRole('list', { name: 'Open incidents' });
    const links = await within(list).findAllByRole('link');
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveAttribute('href', '/p/security.incident?id=inc-1042');
    expect(links[0]).toHaveTextContent('Impossible travel for adele.vance@example.com');
    expect(links[0]).toHaveTextContent('High');
    expect(within(links[0]!).getByText('High').closest('[data-status]')).toHaveAttribute('data-status', 'crit');
    expect(links[0]).toHaveTextContent('25 min ago');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('caps rows at `limit` and says how many there are', () => {
    const config = WIDGETS.list!.schema.parse({ ...listFixtures.incidents.config, limit: 2 }) as ListConfig;
    renderWidget(List, config, ready(listFixtures.incidents.rows));
    expect(screen.getByRole('list', { name: 'Open incidents' }).children).toHaveLength(2);
    expect(screen.getByText('Showing 2 of 3')).toBeInTheDocument();
  });

  it('strips HTML that arrives in data (message center bodies)', () => {
    const config = WIDGETS.list!.schema.parse({ widget: 'list', title: 'Messages', data: 'm.value', primary: 'title', secondary: 'body' }) as ListConfig;
    const { container } = renderWidget(List, config, ready([{ id: '1', title: 'Plan for change', body: '<p>Retire <b>connectors</b></p><script>alert(1)</script>' }]));
    expect(container.querySelector('script, b')).toBeNull();
    expect(screen.getByText('Retire connectors')).toBeInTheDocument();
  });

  it('empty copy invites action; errors carry the code', () => {
    const a = renderWidget(List, listConfig, ready([]));
    expect(screen.getByText('Nothing needs attention')).toBeInTheDocument();
    a.unmount();
    renderWidget(List, listConfig, failed());
    expect(screen.getByRole('alert')).toHaveTextContent('forbidden');
  });
});

describe('timeline widget', () => {
  it('events newest first, status as glyph + spoken label, templated detail', async () => {
    const { container } = renderWidget(Timeline, timelineConfig, ready(timelineFixtures.audit.rows));
    const list = screen.getByRole('list', { name: 'Recent changes' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Update user'),
      expect.stringContaining('Add member to group'),
      expect.stringContaining('Reset password'),
    ]);
    expect(items[1]).toHaveTextContent('Failure:');
    expect(await within(list).findByText('lee.gu@example.com')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent changes' })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('empty period copy', () => {
    renderWidget(Timeline, timelineConfig, ready([]));
    expect(screen.getByText('No activity in this period')).toBeInTheDocument();
  });
});
