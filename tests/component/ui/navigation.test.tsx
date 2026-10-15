import { render, screen, within } from '@testing-library/react';
import { Breadcrumbs, Icon, loadIcons, PageHeader, type LinkComponent } from '@adminforge/ui';
import { axeViolations } from '../axe';

describe('PageHeader', () => {
  it('renders one h1 with eyebrow, description, meta, actions and breadcrumbs', async () => {
    const { container } = render(
      <PageHeader
        breadcrumbs={[
          { label: 'Identity' },
          { label: 'Users', href: '/identity/users' },
          { label: 'Adele Vance' },
        ]}
        eyebrow="User"
        title="Adele Vance"
        meta={<span>Enabled</span>}
        description="adele.vance@example.com · Finance"
        actions={<button type="button">Disable sign-in</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Adele Vance' })).toHaveClass('af-page-title');
    expect(screen.getByText('User')).toHaveClass('af-eyebrow');
    expect(screen.getByText('adele.vance@example.com · Finance')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable sign-in' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/identity/users');
    expect(within(nav).getByText('Adele Vance')).toHaveAttribute('aria-current', 'page');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('omits the breadcrumb landmark when there are none', () => {
    render(<PageHeader title="Overview" />);
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});

describe('Breadcrumbs', () => {
  it('renders links through a custom link component and never links the current page', async () => {
    const Custom: LinkComponent = ({ href, className, children }) => (
      <a href={`#router${href}`} className={className} data-custom="yes">
        {children}
      </a>
    );
    const { container } = render(
      <Breadcrumbs
        linkAs={Custom}
        items={[
          { label: 'Microsoft 365', href: '/m365' },
          { label: 'Licences', href: '/m365/licences' },
        ]}
      />,
    );
    const items = within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByRole('link', { name: 'Microsoft 365' })).toHaveAttribute(
      'data-custom',
      'yes',
    );
    expect(within(items[1]!).queryByRole('link')).toBeNull();
    expect(within(items[1]!).getByText('Licences')).toHaveAttribute('aria-current', 'page');
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('Icon', () => {
  beforeAll(async () => {
    await loadIcons();
  });

  it('resolves kebab-case and PascalCase Phosphor names to the same glyph', () => {
    const { container } = render(
      <div>
        <span data-testid="kebab">
          <Icon name="shield-check" />
        </span>
        <span data-testid="pascal">
          <Icon name="ShieldCheck" />
        </span>
        <span data-testid="suffixed">
          <Icon name="ShieldCheckIcon" />
        </span>
      </div>,
    );
    const html = (id: string) => screen.getByTestId(id).querySelector('svg')!.innerHTML;
    expect(screen.getByTestId('kebab').querySelector('svg')).not.toBeNull();
    expect(html('kebab')).toBe(html('pascal'));
    expect(html('kebab')).toBe(html('suffixed'));
    container.querySelectorAll('svg').forEach((svg) => expect(svg).toHaveAttribute('aria-hidden', 'true'));
  });

  it('falls back to a neutral glyph for unknown names', () => {
    render(
      <div>
        <span data-testid="unknown">
          <Icon name="definitely-not-an-icon" />
        </span>
        <span data-testid="fallback">
          <Icon name="squares-four" />
        </span>
        <span data-testid="none">
          <Icon name={undefined} />
        </span>
      </div>,
    );
    const html = (id: string) => screen.getByTestId(id).querySelector('svg')!.innerHTML;
    expect(html('unknown')).toBe(html('fallback'));
    expect(html('none')).toBe(html('fallback'));
  });

  it('is an image with a name when labelled', async () => {
    const { container } = render(<Icon name="house" label="Overview" size={20} />);
    const img = screen.getByRole('img', { name: 'Overview' });
    expect(img).toHaveAttribute('width', '20');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('every content icon used by navigation.yaml resolves', () => {
    const names = [
      'house',
      'identification-card',
      'squares-four',
      'devices',
      'shield-check',
      'cloud',
      'lightning',
      'list-checks',
      'calendar-check',
      'pulse',
      'chart-bar',
      'gear-six',
      'scroll',
      'palette',
      'users',
      'key',
      'prohibit',
      'arrow-square-out',
    ];
    const { container } = render(
      <div>
        <span data-testid="fallback">
          <Icon name="squares-four" />
        </span>
        {names.map((n) => (
          <span key={n} data-icon={n}>
            <Icon name={n} />
          </span>
        ))}
      </div>,
    );
    const fallback = screen.getByTestId('fallback').querySelector('svg')!.innerHTML;
    const unresolved = names.filter(
      (n) =>
        n !== 'squares-four' && container.querySelector(`[data-icon="${n}"] svg`)!.innerHTML === fallback,
    );
    expect(unresolved).toEqual([]);
  });
});
