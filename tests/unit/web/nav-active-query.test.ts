import { isActive } from '@adminforge/web/src/app/NavRail';

// Two nav items can link to one page: Automation › Synthetic monitoring (/monitoring) and Exchange Online › Service
// checks (/monitoring?group=exchange). Exactly one is highlighted: the item whose query the URL carries, else the plain one.
const hrefs = ['/monitoring', '/monitoring?group=exchange', '/monitoring?group=teams', '/runs'];

describe('isActive with query-string items', () => {
  it('highlights the item whose query matches, not the plain one', () => {
    expect(isActive('/monitoring?group=exchange', '/monitoring', { group: 'exchange' }, hrefs)).toBe(true);
    expect(isActive('/monitoring?group=teams', '/monitoring', { group: 'exchange' }, hrefs)).toBe(false);
    expect(isActive('/monitoring', '/monitoring', { group: 'exchange' }, hrefs)).toBe(false);
  });

  it('keeps the plain item for the page without (or with another) query', () => {
    expect(isActive('/monitoring', '/monitoring', {}, hrefs)).toBe(true);
    expect(isActive('/monitoring', '/monitoring', { show: 'problems' }, hrefs)).toBe(true);
    expect(isActive('/monitoring?group=exchange', '/monitoring', {}, hrefs)).toBe(false);
    // Extra params don't stop a match.
    expect(
      isActive('/monitoring?group=exchange', '/monitoring', { group: 'exchange', by: 'check' }, hrefs),
    ).toBe(true);
  });

  it('is unchanged for items without siblings', () => {
    expect(isActive('/runs', '/runs/abc', {}, hrefs)).toBe(true);
    expect(isActive('/', '/', {}, hrefs)).toBe(true);
    expect(isActive('/', '/runs', {}, hrefs)).toBe(false);
  });
});
