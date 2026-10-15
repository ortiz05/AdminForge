import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { Icon } from '@adminforge/ui';
import { loadPhosphorIcon, phosphorIconCount } from '../../../portal/packages/ui/src/primitives/icon-loader';

describe('Icon: any Phosphor glyph on demand', () => {
  it('knows the whole Phosphor set without loading it', () => {
    expect(phosphorIconCount()).toBeGreaterThan(1000);
  });

  // Each glyph is its own module; the first transform can be slow on a busy machine.
  it(
    'loads kebab-case names outside the curated set (siren, microsoft-teams-logo, FirstAidKit)',
    { timeout: 45_000 },
    async () => {
      // Failed chunk loads are deliberately not cached, so retrying is what the UI does too; under a fully loaded test run
      // the module runner can drop a dynamic import or two.
      const eventually = (name: string) =>
        vi.waitFor(async () => expect(await loadPhosphorIcon(name)).toBeTruthy(), {
          timeout: 20_000,
          interval: 250,
        });
      await eventually('microsoft-teams-logo');
      await eventually('FirstAidKit');
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
      // Wait for a rendered, visible glyph — an absent <svg> (still loading) must not satisfy the condition.
      const visible = (id: string) => {
        const el = svg(id);
        expect(el).not.toBeNull();
        expect(el!.style.visibility).not.toBe('hidden');
      };
      await waitFor(() => visible('siren'), { timeout: 20_000 });
      await waitFor(() => visible('fallback'), { timeout: 20_000 });
      expect(svg('siren')!.innerHTML).not.toBe(svg('fallback')!.innerHTML);
    },
  );
});
