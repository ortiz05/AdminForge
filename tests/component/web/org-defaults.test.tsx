import { applyPrefs, resolveTheme, setOrgDefaults } from '@adminforge/web/src/lib/prefs';

// Admin → Appearance defaults apply to people without their own theme/density; their own choice always wins.
afterEach(() => setOrgDefaults(undefined));

describe('organisation defaults', () => {
  it('the default theme applies only without a personal choice', () => {
    setOrgDefaults({ theme: 'daylight' });
    expect(resolveTheme(undefined)).toBe('daylight');
    expect(resolveTheme('contrast')).toBe('contrast');
  });

  it('"system" as the org default (or none) follows the OS', () => {
    setOrgDefaults({ theme: 'system' });
    expect(resolveTheme(undefined)).toBe('steel');
    setOrgDefaults(undefined);
    expect(resolveTheme(undefined)).toBe('steel');
  });

  it('the default density is applied to <html> (it was ignored before: the attribute was always set)', () => {
    const root = document.createElement('html');
    setOrgDefaults({ density: 'compact' });
    applyPrefs({}, root);
    expect(root.dataset.density).toBe('compact');
    applyPrefs({ density: 'comfortable' }, root);
    expect(root.dataset.density).toBe('comfortable');
  });
});
