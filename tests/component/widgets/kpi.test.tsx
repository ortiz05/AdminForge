import { screen, within } from '@testing-library/react';
import { WIDGETS, kpiFixtures, type KpiConfig } from '@adminforge/widgets';
import { axeViolations } from '../axe';
import { failed, loading, ready, renderWidget, spyRuntime } from './helpers';

const Kpi = WIDGETS.kpi!.component;
const cfg = (c: KpiConfig) => WIDGETS.kpi!.schema.parse(c) as KpiConfig;

describe('kpi widget', () => {
  it('shows the label and the number', async () => {
    const { container } = renderWidget(Kpi, cfg(kpiFixtures.members.config), ready(kpiFixtures.members.value));
    const tile = screen.getByRole('group', { name: 'Members' });
    expect(tile).toHaveTextContent('12,408');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('reads `value` from an object result (or `field`)', () => {
    renderWidget(Kpi, cfg({ widget: 'kpi', data: 'x', label: 'Seats' }), ready({ value: 42 }));
    expect(screen.getByRole('group', { name: 'Seats' })).toHaveTextContent('42');
  });

  it('evaluates a status expression into icon + words', async () => {
    const { container } = renderWidget(Kpi, cfg(kpiFixtures.disabled.config), ready(kpiFixtures.disabled.value));
    const tile = screen.getByRole('group', { name: 'Disabled' });
    expect(await within(tile).findByText('Needs review')).toBeInTheDocument();
    expect(tile.querySelector('svg')).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('shows no status while the value is missing', async () => {
    renderWidget(Kpi, cfg(kpiFixtures.disabled.config), ready(null));
    const tile = screen.getByRole('group', { name: 'Disabled' });
    expect(tile).toHaveTextContent('—');
    await new Promise((r) => setTimeout(r, 20));
    expect(within(tile).queryByText('Healthy')).toBeNull();
  });

  it('formats percent fractions ×100 and shows a signed delta from another datasource path', async () => {
    const { runtime } = spyRuntime({ data: { mfa: { ratio: 0.042, delta: -0.006 } } });
    const { container } = renderWidget(Kpi, cfg(kpiFixtures.noMfa.config), ready(kpiFixtures.noMfa.value), runtime);
    const link = screen.getByRole('link', { name: /Open Without MFA/ });
    expect(link).toHaveAttribute('href', '/p/identity.users?mfa=none');
    expect(link).toHaveTextContent('4.2%');
    expect(link).toHaveTextContent('−0.6%');
    expect(link).toHaveTextContent('vs last week');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('a loading KPI is busy; an error says Unavailable with the message', async () => {
    const { unmount } = renderWidget(Kpi, cfg(kpiFixtures.members.config), loading);
    expect(screen.getByRole('group', { name: 'Members' })).toHaveAttribute('aria-busy', 'true');
    unmount();
    renderWidget(Kpi, cfg(kpiFixtures.members.config), failed());
    const tile = screen.getByRole('group', { name: 'Members' });
    expect(tile).toHaveTextContent('—');
    expect(tile).toHaveTextContent('Unavailable');
    expect(tile).toHaveTextContent('Microsoft Graph refused this request (403).');
  });

});
