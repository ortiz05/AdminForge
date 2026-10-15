import { act, render, screen, within } from '@testing-library/react';
import { EmptyState, ErrorState, Kpi, KpiStrip, ProvenanceFooter, Timeline } from '@adminforge/ui';
import { axeViolations } from '../axe';

describe('Kpi', () => {
  it('formats the value, labels the group, and shows status as icon + text', async () => {
    const { container } = render(
      <Kpi
        label="Users"
        value={12408}
        status={{ tone: 'warn', label: '2 services' }}
        hint="Members and guests"
      />,
    );
    const group = screen.getByRole('group', { name: 'Users' });
    expect(within(group).getByText('12,408')).toBeInTheDocument();
    const status = within(group).getByText('2 services').parentElement!;
    expect(status.className).toContain('text-warn');
    expect(status.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(within(group).getByText('Members and guests')).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('shows a signed delta with a direction arrow and period', () => {
    render(
      <Kpi
        label="Sign-ins"
        value={4650}
        delta={{ value: '+3.2%', direction: 'up', good: true, period: 'vs last Monday' }}
        trend={[1, 2, 3, 4]}
      />,
    );
    const delta = screen.getByText('+3.2%');
    expect(delta.className).toContain('text-ok');
    expect(delta.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('vs last Monday')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Sign-ins trend' })).toBeInTheDocument();
  });

  it('bad news is cinder', () => {
    render(<Kpi label="Failures" value={12} delta={{ value: '+40%', direction: 'up', good: false }} />);
    expect(screen.getByText('+40%').className).toContain('text-crit');
  });

  it('while loading shows a skeleton and is busy', async () => {
    const { container } = render(<Kpi label="Stale devices" value={null} loading />);
    const group = screen.getByRole('group', { name: 'Stale devices' });
    expect(group).toHaveAttribute('aria-busy', 'true');
    expect(group.querySelector('.af-skeleton')).not.toBeNull();
    expect(within(group).queryByText('—')).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('shows an em dash for a missing value and keeps units', () => {
    render(
      <div>
        <Kpi label="Unknown" value={undefined} />
        <Kpi label="Latency" value="182" unit="ms" />
      </div>,
    );
    expect(within(screen.getByRole('group', { name: 'Unknown' })).getByText('—')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Latency' })).getByText('ms')).toBeInTheDocument();
  });
});

describe('KpiStrip', () => {
  it('groups cells in one labelled section', async () => {
    const { container } = render(
      <KpiStrip label="Key figures">
        <Kpi variant="cell" label="Users" value={1} />
        <Kpi variant="cell" label="Groups" value={2} />
      </KpiStrip>,
    );
    const strip = screen.getByRole('region', { name: 'Key figures' });
    expect(within(strip).getAllByRole('group')).toHaveLength(2);
    expect(within(strip).getByRole('group', { name: 'Users' }).className).not.toContain('border');
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('ProvenanceFooter', () => {
  it('reads "graph · /users · 1.2 s · cached 30 s ago"', async () => {
    const cachedAt = new Date(Date.now() - 30_000).toISOString();
    const { container } = render(
      <ProvenanceFooter
        service="graph"
        path="/users"
        ms={1234}
        cachedAt={cachedAt}
        requestId="7b1e0f42-93ad-4c58-b2e6-5a0d81c4f3e9"
      />,
    );
    const p = container.querySelector('p')!;
    expect(p.textContent).toBe('Data source: graph·/users·1.2 s·cached 30 s ago');
    expect(p.getAttribute('title')).toContain('Request ID 7b1e0f42-93ad-4c58-b2e6-5a0d81c4f3e9');
    expect(p.className).toContain('font-mono');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('says live when not cached and omits the time when unknown', () => {
    const { container } = render(<ProvenanceFooter service="graph" path="/organization" />);
    expect(container.querySelector('p')!.textContent).toBe('Data source: graph·/organization·live');
  });

  it('refreshes the relative time every 15 seconds', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-15T14:00:00Z'));
      const { container } = render(
        <ProvenanceFooter service="graph" path="/users" ms={95} cachedAt="2026-10-15T13:59:30Z" />,
      );
      expect(container).toHaveTextContent('cached 30 s ago');
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expect(container).toHaveTextContent('cached 45 s ago');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Timeline', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it('is an ordered list whose status is read as text', async () => {
    const { container } = render(
      <Timeline
        label="Offboarding run"
        items={[
          {
            id: '1',
            title: 'Disable sign-in',
            time: ago(8 * 60_000),
            status: 'ok',
            statusLabel: 'Succeeded',
          },
          {
            id: '2',
            title: 'Remove licences',
            time: ago(5 * 60_000),
            status: 'warn',
            description: '1 of 3 is group-assigned',
          },
          { id: '3', title: 'Approval', time: ago(60_000) },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Offboarding run' });
    expect(list.tagName).toBe('OL');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Succeeded: Disable sign-in');
    expect(items[0]).toHaveTextContent('8 min ago');
    expect(items[1]).toHaveTextContent('warn: Remove licences');
    expect(items[2]).toHaveTextContent('neutral: Approval');
    expect(items[0]!.querySelector('time')).toHaveAttribute('dateTime');
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('EmptyState', () => {
  it('invites action', async () => {
    const onClick = vi.fn();
    const { container } = render(
      <EmptyState
        title="No playbooks in this category yet"
        action={
          <button type="button" onClick={onClick}>
            New playbook
          </button>
        }
      >
        Create one with the CLI.
      </EmptyState>,
    );
    expect(screen.getByText('No playbooks in this category yet')).toBeInTheDocument();
    expect(screen.getByText('Create one with the CLI.')).toBeInTheDocument();
    screen.getByRole('button', { name: 'New playbook' }).click();
    expect(onClick).toHaveBeenCalledOnce();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('ErrorState', () => {
  it('announces as an alert with code and correlation id', async () => {
    const { container } = render(
      <ErrorState
        title="Microsoft Graph refused this request (403)"
        message="Your account has no Entra role that can read sign-in logs."
        hint="Activate Reports Reader in PIM."
        code="forbidden"
        correlationId="5f0c2e81-7a4d-4b39-8c6e-1d2f3a4b5c6d"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Microsoft Graph refused this request (403)');
    expect(alert).toHaveTextContent('Activate Reports Reader in PIM.');
    expect(within(alert).getByText('forbidden').className).toContain('font-mono');
    expect(
      within(alert).getByRole('button', { name: 'Copy Reference 5f0c2e81-7a4d-4b39-8c6e-1d2f3a4b5c6d' }),
    ).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});
