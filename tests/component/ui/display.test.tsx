import { render, screen, within } from '@testing-library/react';
import {
  AnvilMark,
  Avatar,
  Badge,
  Brand,
  Kbd,
  Meter,
  Panel,
  Skeleton,
  SkeletonText,
  Sparkline,
  StatusPill,
  STATUS_TONES,
} from '@adminforge/ui';
import { axeViolations } from '../axe';

describe('Brand', () => {
  it('renders the wordmark "AdminForge" with the anvil mark', async () => {
    const { container } = render(<Brand />);
    expect(container).toHaveTextContent('AdminForge');
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Forge')).toBeInTheDocument();
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('fill', 'currentColor');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('compact keeps the name for assistive tech but hides it visually', async () => {
    const { container } = render(<Brand compact />);
    const word = screen.getByText('Admin').parentElement!;
    expect(word.className).toContain('sr-only');
    expect(container).toHaveTextContent('AdminForge');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('AnvilMark is decorative and sized', () => {
    const { container } = render(<AnvilMark size={30} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('width', '30');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('StatusPill', () => {
  it('always carries an icon and a label for every tone (never colour alone)', async () => {
    const { container } = render(
      <div>
        {STATUS_TONES.map((t) => (
          <StatusPill key={t} status={t}>
            {`State ${t}`}
          </StatusPill>
        ))}
      </div>,
    );
    for (const t of STATUS_TONES) {
      const pill = screen.getByText(`State ${t}`).closest('[data-status]')!;
      expect(pill).toHaveAttribute('data-status', t);
      expect(pill.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
    expect(await axeViolations(container)).toEqual([]);
  });

  it('uses the subtle fill with solid text for its tone', () => {
    render(<StatusPill status="crit">Interruption</StatusPill>);
    const pill = screen.getByText('Interruption').closest('[data-status]')!;
    expect(pill.className).toContain('bg-crit-subtle');
    expect(pill.className).toContain('text-crit');
  });
});

describe('Badge', () => {
  it('renders tones and mono variant', async () => {
    const { container } = render(
      <div>
        <Badge>Member</Badge>
        <Badge tone="accent">Default</Badge>
        <Badge tone="outline" mono>
          forbidden
        </Badge>
      </div>,
    );
    expect(screen.getByText('Default').className).toContain('bg-accent-subtle');
    expect(screen.getByText('forbidden').className).toContain('font-mono');
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('Kbd', () => {
  it('shows key caps and reads the chord as text', async () => {
    const { container } = render(<Kbd keys={['Ctrl', 'K']} />);
    const caps = container.querySelectorAll('kbd');
    expect(caps).toHaveLength(2);
    caps.forEach((k) => expect(k).toHaveAttribute('aria-hidden', 'true'));
    expect(screen.getByText('Ctrl K')).toHaveClass('sr-only');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('accepts a single key', () => {
    const { container } = render(<Kbd keys="Esc" />);
    expect(container.querySelectorAll('kbd')).toHaveLength(1);
  });
});

describe('Avatar', () => {
  it('shows initials and is decorative', async () => {
    const { container } = render(<Avatar name="Mock Engineer" />);
    const el = screen.getByText('ME');
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('uses the first two letters of a single name', () => {
    render(<Avatar name="Yuki" />);
    expect(screen.getByText('YU')).toBeInTheDocument();
  });
});

describe('Skeleton', () => {
  it('is hidden from assistive technology', async () => {
    const { container } = render(
      <div>
        <Skeleton data-testid="one" />
        <SkeletonText lines={3} />
      </div>,
    );
    expect(screen.getByTestId('one')).toHaveAttribute('aria-hidden', 'true');
    const text = container.querySelectorAll('.af-skeleton');
    expect(text.length).toBe(4);
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('Panel', () => {
  it('renders eyebrow, title, actions, body and footer, labelled by its title', async () => {
    const { container } = render(
      <Panel
        eyebrow="Licensing"
        title="Subscriptions"
        actions={<button type="button">Refresh</button>}
        footer={<p>graph · /subscribedSkus</p>}
      >
        <p>Body content</p>
      </Panel>,
    );
    const region = screen.getByRole('region', { name: 'Subscriptions' });
    expect(within(region).getByRole('heading', { level: 2, name: 'Subscriptions' })).toBeInTheDocument();
    expect(within(region).getByText('Licensing')).toHaveClass('af-eyebrow');
    expect(within(region).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(within(region).getByText('Body content')).toBeInTheDocument();
    expect(within(region).getByRole('contentinfo')).toHaveTextContent('graph · /subscribedSkus');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('headless panel has no header', () => {
    const { container } = render(<Panel>Only body</Panel>);
    expect(container.querySelector('header')).toBeNull();
    expect(container).toHaveTextContent('Only body');
  });
});

describe('Meter', () => {
  it('exposes a meter with value text', async () => {
    const { container } = render(<Meter value={312} max={500} label="Microsoft 365 E3" />);
    const meter = screen.getByRole('meter', { name: 'Microsoft 365 E3' });
    expect(meter).toHaveAttribute('aria-valuenow', '312');
    expect(meter).toHaveAttribute('aria-valuemax', '500');
    expect(meter).toHaveAttribute('aria-valuetext', '62% (312 of 500)');
    expect(meter.className).toContain('bg-accent-subtle');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('turns straw then cinder as it fills', () => {
    render(
      <div>
        <Meter value={441} max={500} label="Warn" />
        <Meter value={500} max={500} label="Crit" />
      </div>,
    );
    expect(screen.getByRole('meter', { name: 'Warn' }).className).toContain('bg-warn-subtle');
    expect(screen.getByRole('meter', { name: 'Crit' }).className).toContain('bg-crit-subtle');
  });

  it('handles a zero max without dividing by zero', () => {
    render(<Meter value={0} max={0} label="Empty" />);
    expect(screen.getByRole('meter', { name: 'Empty' })).toHaveAttribute('aria-valuetext', '0% (0 of 0)');
  });
});

describe('Sparkline', () => {
  it('is an image with a spoken summary', async () => {
    const { container } = render(<Sparkline data={[1, 3, 2, 5]} label="Sign-ins, rising from 1 to 5" />);
    const img = screen.getByRole('img', { name: 'Sign-ins, rising from 1 to 5' });
    expect(img.querySelectorAll('path')).toHaveLength(2);
    expect(img.querySelector('circle')).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('degrades gracefully with fewer than two points', () => {
    render(<Sparkline data={[4]} label="Not enough data" />);
    expect(screen.getByRole('img', { name: 'Not enough data' }).tagName).toBe('SPAN');
  });
});
