import { followSafeUrl } from '@adminforge/ui';
import { followHref as followAppHref } from '@adminforge/web/src/lib/links';
import { followHref as followActionHref, type WidgetRuntime } from '@adminforge/widgets';

// Two `followHref`s followed an href templated from data: the app's (useNavigateHref: row and menu navigation) and the
// widgets' (content actions). Each repeated the rule — nothing unless safeUrl allows it, external in a new tab without
// opener, in-app through the router — so a change to one could miss the other. The rule is `followSafeUrl` in
// @adminforge/ui now, next to safeUrl, and both call it.

const HREFS = [
  '/p/identity.users?userType=Guest',
  '#details',
  'https://learn.microsoft.com/',
  'mailto:soc@example.com',
  '/\\evil.example.com',
  '//evil.example.com',
  'javascript:alert(1)',
  'relative/path',
  '',
];

afterEach(() => vi.restoreAllMocks());

/** What following `href` did: the in-app navigations and the windows opened. */
function follow(go: (navigate: (href: string) => void) => boolean) {
  const opened: unknown[][] = [];
  vi.spyOn(window, 'open').mockImplementation((...args: unknown[]) => {
    opened.push(args);
    return null;
  });
  const navigated: string[] = [];
  const followed = go((href) => navigated.push(href));
  vi.restoreAllMocks();
  return { followed, navigated, opened };
}

describe('followSafeUrl', () => {
  it('follows only what safeUrl allows: in-app through navigate, external in a new tab without opener', () => {
    expect(follow((nav) => followSafeUrl('/runs', nav))).toEqual({
      followed: true,
      navigated: ['/runs'],
      opened: [],
    });
    expect(follow((nav) => followSafeUrl('https://learn.microsoft.com/', nav))).toEqual({
      followed: true,
      navigated: [],
      opened: [['https://learn.microsoft.com/', '_blank', 'noopener,noreferrer']],
    });
    for (const href of ['//evil.example.com', 'javascript:alert(1)', '', 42, null, undefined])
      expect(follow((nav) => followSafeUrl(href, nav))).toEqual({
        followed: false,
        navigated: [],
        opened: [],
      });
  });

  it('opens an in-app address in a new tab when asked', () => {
    expect(follow((nav) => followSafeUrl('/runs', nav, { newTab: true }))).toEqual({
      followed: true,
      navigated: [],
      opened: [['/runs', '_blank', 'noopener,noreferrer']],
    });
  });
});

describe("the app's and the widgets' followHref follow the same rule", () => {
  it.each(HREFS)('%j', (href) => {
    const rule = follow((nav) => followSafeUrl(href, nav));
    const app = follow((nav) =>
      followAppHref({ navigate: ({ href: to }: { href: string }) => nav(to) }, href),
    );
    const action = follow((nav) =>
      followActionHref({ navigate: (to: string) => nav(to) } as unknown as WidgetRuntime, href),
    );
    expect(app).toEqual(rule);
    expect(action).toEqual(rule);
  });
});
