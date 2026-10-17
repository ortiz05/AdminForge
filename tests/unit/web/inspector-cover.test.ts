import { scale } from '@adminforge/design-tokens';
import {
  inspectorCoversList,
  inspectorWidthPx,
  MIN_LIST_BESIDE_INSPECTOR_REM,
} from '@adminforge/web/src/app/inspector-cover';

// The inspector's width and cover mode come from the design tokens: factor × inspector-w, never over the rail, and
// covering the list when less than 24rem of it would be left beside the drawer.
const px = (v: string) => Number.parseFloat(v);
const L = scale.layout;
const wide = Number(L['inspector-wide-factor']) * px(L['inspector-w']);

describe('inspector width and cover mode', () => {
  it('is factor × inspector-w when there is room, otherwise the space beside the rail', () => {
    expect(inspectorWidthPx(4000, false)).toBe(wide);
    expect(inspectorWidthPx(1280, false)).toBe(1280 - px(L['nav-w']));
    expect(inspectorWidthPx(1280, true)).toBe(1280 - px(L['nav-w-collapsed']));
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
