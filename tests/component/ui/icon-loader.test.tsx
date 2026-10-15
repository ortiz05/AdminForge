import { render, screen, waitFor } from '@testing-library/react';
import { Icon } from '@adminforge/ui';
import { loadPhosphorIcon, phosphorIconCount } from '../../../portal/packages/ui/src/primitives/icon-loader';

describe('Icon: any Phosphor glyph on demand', () => {
  it('knows the whole Phosphor set without loading it', () => {
    expect(phosphorIconCount()).toBeGreaterThan(1000);
  });

  // Each glyph is its own module; the first transform can be slow on a busy machine.
  it('loads kebab-case names outside the curated set (siren, microsoft-teams-logo, FirstAidKit)', { timeout: 15_000 }, async () => {
    expect(await loadPhosphorIcon('microsoft-teams-logo')).toBeTruthy();
    expect(await loadPhosphorIcon('FirstAidKit')).toBeTruthy();
    expect(await loadPhosphorIcon('definitely-not-an-icon')).toBeNull();
    render(
      <div>
        <span data-testid="siren">
          <Icon name="siren" />
        </span>
        <span data-testid="fallback">
          <Icon name="definitely-not-an-icon" />
        </span>
      </div>,
    );
    const svg = (id: string) => screen.getByTestId(id).querySelector('svg');
    await waitFor(() => expect(svg('siren')?.style.visibility).not.toBe('hidden'), { timeout: 5000 });
    await waitFor(() => expect(svg('fallback')?.style.visibility).not.toBe('hidden'), { timeout: 5000 });
    expect(svg('siren')!.innerHTML).not.toBe(svg('fallback')!.innerHTML);
  });
});
