import {
  maySignInAutomatically,
  noteAutomaticSignIn,
  SIGN_IN_REDIRECT_WINDOW_MS,
} from '@adminforge/web/src/lib/sign-in-guard';

// At most one automatic trip to sign-in per tab within the window: a second 401 right after the round trip would
// otherwise loop through single sign-on forever (the inspector "refreshing loop").
const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('automatic sign-in guard', () => {
  it('allows the first automatic sign-in', () => {
    expect(maySignInAutomatically(1_000_000, store())).toBe(true);
  });

  it('holds back another one within the window, and allows it again afterwards', () => {
    const s = store();
    noteAutomaticSignIn(1_000_000, s);
    expect(maySignInAutomatically(1_000_000 + 5_000, s)).toBe(false);
    expect(maySignInAutomatically(1_000_000 + SIGN_IN_REDIRECT_WINDOW_MS - 1, s)).toBe(false);
    expect(maySignInAutomatically(1_000_000 + SIGN_IN_REDIRECT_WINDOW_MS, s)).toBe(true);
  });

  it('ignores a timestamp from the future (clock change) and garbage', () => {
    const s = store();
    noteAutomaticSignIn(2_000_000, s);
    expect(maySignInAutomatically(1_000_000, s)).toBe(true);
    s.setItem('af.signin.redirectedAt', 'not-a-number');
    expect(maySignInAutomatically(1_000_000, s)).toBe(true);
  });

  it('without storage (private mode, blocked) every redirect is allowed, as before', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => noteAutomaticSignIn(1, throwing)).not.toThrow();
    expect(maySignInAutomatically(2, throwing)).toBe(true);
    expect(maySignInAutomatically(2, undefined)).toBe(true);
  });
});
