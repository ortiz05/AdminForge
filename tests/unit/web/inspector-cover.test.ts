import { scale } from '@adminforge/design-tokens';
import {
  inspectorCoversList,
  inspectorWidthPx,
  MIN_LIST_BESIDE_INSPECTOR_REM,
} from '@adminforge/web/src/app/inspector-cover';

// The inspector's width and cover mode come from the design tokens: factor × inspector-w, never over the rail, and
// covering the list when less than MIN_LIST_BESIDE_INSPECTOR_REM of it would be left beside the drawer.
const px = (v: string) => Number.parseFloat(v);
const L = scale.layout;
const wide = Number(L['inspector-wide-factor']) * px(L['inspector-w']);
const listBeside = (viewport: number, collapsed: boolean) =>
  viewport - px(collapsed ? L['nav-w-collapsed'] : L['nav-w']) - inspectorWidthPx(viewport, collapsed);

describe('inspector width and cover mode', () => {
  it('is factor × inspector-w when there is room, otherwise the space beside the rail', () => {
    expect(inspectorWidthPx(4000, false)).toBe(wide);
    expect(inspectorWidthPx(1000, false)).toBe(1000 - px(L['nav-w']));
    expect(inspectorWidthPx(800, true)).toBe(800 - px(L['nav-w-collapsed']));
  });

  it('covers the list when less than the minimum would be left beside it', () => {
    const roomExpanded = wide + px(L['nav-w']) + MIN_LIST_BESIDE_INSPECTOR_REM * 16;
    expect(inspectorCoversList(roomExpanded - 1, false)).toBe(true);
    expect(inspectorCoversList(roomExpanded, false)).toBe(false);
    const roomCollapsed = wide + px(L['nav-w-collapsed']) + MIN_LIST_BESIDE_INSPECTOR_REM * 16;
    expect(inspectorCoversList(roomCollapsed - 1, true)).toBe(true);
    expect(inspectorCoversList(roomCollapsed, true)).toBe(false);
  });

  it('a larger root font size needs more list beside it', () => {
    const room = wide + px(L['nav-w']) + MIN_LIST_BESIDE_INSPECTOR_REM * 16;
    expect(inspectorCoversList(room, false, 20)).toBe(true);
  });
});

// D-10 (platform review 2026-10-21): at factor 3 the drawer left 0 px of the list at 1440 and covered it at 1920 too.
// At factor 2 (920 px) the list stays beside it on the common laptop and desktop widths.
describe('the list stays visible beside the inspector', () => {
  it('is 920 px wide (factor 2 × 460 px)', () => {
    expect(L['inspector-wide-factor']).toBe('2');
    expect(inspectorWidthPx(1440, false)).toBe(920);
    expect(inspectorWidthPx(1920, false)).toBe(920);
  });

  it('keeps 280 px of the list at 1440 and 760 px at 1920, rail expanded — beside, not covering', () => {
    expect(listBeside(1440, false)).toBe(280);
    expect(inspectorCoversList(1440, false)).toBe(false);
    expect(listBeside(1920, false)).toBe(760);
    expect(inspectorCoversList(1920, false)).toBe(false);
  });

  it('with the rail collapsed it stays beside the list from 1280 up', () => {
    expect(listBeside(1280, true)).toBe(304);
    expect(inspectorCoversList(1280, true)).toBe(false);
    expect(inspectorCoversList(1440, true)).toBe(false);
  });

  it('still covers the list at 1280 with the rail expanded (120 px would be left)', () => {
    expect(listBeside(1280, false)).toBe(120);
    expect(inspectorCoversList(1280, false)).toBe(true);
  });
});
