import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Drawer, drawer } from '@adminforge/ui';
import { axeViolations } from '../axe';

// Header actions sit next to Close (the inspector's "Open full page" is one click away however long the page is), and
// the `wide` size is the inspector's three-times width from its own token; other drawers keep the standard width.
describe('Drawer header actions and size', () => {
  it('renders actions in the header, before Close, and keeps them keyboard reachable', async () => {
    render(
      <Drawer
        open
        onOpenChange={() => {}}
        title="Avery Engineer"
        eyebrow="Inspector · User"
        actions={<a href="/p/identity.user?id=1">Open full page</a>}
      >
        <p>Body</p>
      </Drawer>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Avery Engineer' });
    const link = within(dialog).getByRole('link', { name: 'Open full page' });
    const close = within(dialog).getByRole('button', { name: 'Close' });
    // Same header row, link first.
    expect(link.parentElement).toBe(close.parentElement);
    expect(link.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Before the body in reading order.
    expect(
      link.compareDocumentPosition(within(dialog).getByText('Body')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await userEvent.tab();
    expect(document.activeElement === link || dialog.contains(document.activeElement)).toBe(true);
    expect(await axeViolations(dialog)).toEqual([]);
  });

  it('without actions the header is just the title and Close', () => {
    render(
      <Drawer open onOpenChange={() => {}} title="Details">
        <p>Body</p>
      </Drawer>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Details' });
    expect(within(dialog).queryByRole('link')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('wide uses the inspector-wide tokens (collapsed-rail twin, never over the rail); standard keeps inspector-w', () => {
    const wide = drawer({ size: 'wide' }).content();
    const standard = drawer({}).content();
    expect(wide).toContain('w-(--af-layout-inspector-wide-w)');
    expect(wide).toContain('nav-collapsed:w-(--af-layout-inspector-wide-w-nav-collapsed)');
    // Never full width: the rail stays visible on every screen.
    expect(wide.split(/\s+/)).not.toContain('w-full');
    expect(wide).not.toMatch(/(^|\s)max-sm:w-full/);
    // The wide width replaces the standard one (tailwind-merge), rather than both competing in the stylesheet.
    expect(wide.split(/\s+/)).not.toContain('w-(--af-layout-inspector-w)');
    expect(standard).toContain('w-(--af-layout-inspector-w)');
    expect(standard).not.toContain('inspector-wide-w');
    render(
      <Drawer open onOpenChange={() => {}} title="Wide" size="wide">
        <p>Body</p>
      </Drawer>,
    );
    expect(screen.getByRole('dialog', { name: 'Wide' }).className).toContain('inspector-wide-w');
  });

  it('initialFocus="container": focus starts on the sheet, so Tab reaches the header actions first', async () => {
    render(
      <Drawer
        open
        onOpenChange={() => {}}
        title="Avery Engineer"
        modal={false}
        initialFocus="container"
        actions={<a href="/p/identity.user?id=1">Open full page</a>}
      >
        <button type="button">In the body</button>
      </Drawer>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Avery Engineer' });
    await waitFor(() => expect(dialog).toHaveFocus());
    await userEvent.tab();
    expect(within(dialog).getByRole('link', { name: 'Open full page' })).toHaveFocus();
    await userEvent.tab();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
    await userEvent.tab();
    expect(within(dialog).getByRole('button', { name: 'In the body' })).toHaveFocus();
  });

  it('cover: a light scrim beside the sheet closes the drawer on click', async () => {
    const onOpenChange = vi.fn();
    render(
      <Drawer open onOpenChange={onOpenChange} title="Covering" modal={false} cover>
        <p>Body</p>
      </Drawer>,
    );
    const scrim = document.querySelector<HTMLElement>('[data-drawer-cover]')!;
    expect(scrim).toHaveAttribute('aria-hidden', 'true');
    await userEvent.click(scrim);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a long string title keeps its full text in a tooltip (it wraps or truncates)', () => {
    const long = 'A very long entity name that will not fit in the drawer header on a phone screen';
    render(
      <Drawer open onOpenChange={() => {}} title={long}>
        <p>Body</p>
      </Drawer>,
    );
    expect(screen.getByRole('heading', { name: long })).toHaveAttribute('title', long);
  });
});
