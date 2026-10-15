// Runs before the app boots so the first paint already has the user's theme and density (no flash).
// Mirrors src/lib/prefs.ts: localStorage['adminforge.prefs'] = { theme, density, navCollapsed }.
(function () {
  var root = document.documentElement;
  var prefs;
  try {
    prefs = JSON.parse(localStorage.getItem('adminforge.prefs') || '{}') || {};
  } catch {
    prefs = {};
  }
  var media = function (q) {
    return typeof window.matchMedia === 'function' && window.matchMedia(q).matches;
  };
  var theme = prefs.theme;
  if (theme !== 'steel' && theme !== 'daylight' && theme !== 'contrast') {
    theme = media('(prefers-contrast: more)')
      ? 'contrast'
      : media('(prefers-color-scheme: light)')
        ? 'daylight'
        : 'steel';
  }
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-density', prefs.density === 'compact' ? 'compact' : 'comfortable');
  root.setAttribute('data-nav', prefs.navCollapsed ? 'collapsed' : 'expanded');
})();
