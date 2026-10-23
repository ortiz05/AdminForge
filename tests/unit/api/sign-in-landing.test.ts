import { HOME_AFTER_SIGN_IN, signInReturnTo } from '@adminforge/api/src/auth/return-to';

// A sign-in lands on Monitoring (the health of everything) unless the person was opening a page: a deep link survives,
// the portal's bare address (`/`), nothing and anything unsafe go to Monitoring.
describe('signInReturnTo', () => {
  it('keeps the page the person was opening', () => {
    expect(signInReturnTo('/p/identity.users?q=1')).toBe('/p/identity.users?q=1');
    expect(signInReturnTo('/news?breaking=true')).toBe('/news?breaking=true');
  });

  it('lands on Monitoring for the bare address, nothing, or an unsafe target', () => {
    expect(HOME_AFTER_SIGN_IN).toBe('/monitoring');
    for (const v of ['/', undefined, '', '//evil.example', 'https://evil.example/', '/auth/login'])
      expect(signInReturnTo(v), String(v)).toBe('/monitoring');
  });
});
