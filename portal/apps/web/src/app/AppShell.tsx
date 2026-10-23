import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveUpdates } from './live-updates';
import { errorDescription } from '../lib/errors';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import type { ArmRequest, MeResponse } from '@adminforge/schemas';
import { Brand, Button, ErrorState, Skeleton, useMediaQuery, useToast } from '@adminforge/ui';
import { api, ApiRequestError, ExtendResponse, loginUrl, RedirectResponse } from '../lib/api';
import { maySignInAutomatically } from '../lib/sign-in-guard';
import { browser } from '../lib/browser';
import {
  NARROW_NAV_QUERY,
  applyPrefs,
  getPrefs,
  hydratePrefs,
  pushRecent,
  setOrgDefaults,
  updatePrefs,
  usePrefs,
} from '../lib/prefs';
import { meQuery, SessionContext, useNav, useSession } from '../lib/session';
import { useAppearanceStylesheet } from '../ops/appearance-link';
import { PlaybookDrawerMount } from '../playbooks/PlaybookDrawerMount';
import { forgetAllHistory, setHistoryOwner } from '../query/history';
import { newsSummaryQuery } from '../news/api';
import { useArmState, WARN_BEFORE_MS } from './arm';
import { BreakingPill } from './BreakingPill';
import { ArmControl } from './ArmControl';
import { CommandPalette } from './CommandPalette';
import { DevToolbar } from './DevToolbar';
import { EmergencyBanner } from './EmergencyBanner';
import { Inspector } from './Inspector';
import { NavRail } from './NavRail';
import { RunDock } from './RunDock';
import { SessionRail } from './SessionRail';
import { ShellContext, type ShellApi } from './shell-context';
import { UserMenu } from './UserMenu';

function Splash({ message }: { message: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5" aria-busy="true">
      <Brand size="lg" />
      <div className="flex w-48 flex-col items-center gap-2">
        <Skeleton className="h-1 w-full rounded-pill" />
        <p className="text-sm text-fg-3" role="status">
          {message}
        </p>
      </div>
    </div>
  );
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function SignedInShell({ me, children }: { me: MeResponse; children: ReactNode }) {
  const queryClient = useQueryClient();
  const nav = useNav();
  const prefs = usePrefs();
  const { toast } = useToast();
  const arm = useArmState(me);
  useLiveUpdates();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const narrow = useMediaQuery(NARROW_NAV_QUERY);
  // Own choice wins; without one the rail follows the window width (applyPrefs keeps data-nav in step).
  const collapsed = prefs.navCollapsed ?? narrow;
  useEffect(() => applyPrefs(getPrefs()), [narrow]);
  // Every section starts collapsed each time the portal loads; one the person opens stays open while they move between
  // pages, not across reloads or sign-ins (owner, 2026-10-23: nothing saved, so nothing comes back open).
  const [openSections, setOpenSections] = useState<readonly string[]>([]);
  const closedSections = useMemo(
    () => (nav.data?.sections ?? []).map((s) => s.key).filter((k) => !openSections.includes(k)),
    [nav.data, openSections],
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  useAppearanceStylesheet();
  const [armDialogOpen, setArmDialogOpen] = useState(false);
  // Unread news for the navigation badge and the top-bar pill (polled; `news.updated` refetches it sooner).
  const news = useQuery(newsSummaryQuery);
  const unreadNews = news.data?.unread ?? 0;
  const navCounts = useMemo(
    () =>
      unreadNews > 0
        ? {
            news: {
              count: unreadNews,
              label: `${unreadNews > 99 ? '99+' : unreadNews} unread ${unreadNews === 1 ? 'change' : 'changes'}`,
            },
          }
        : undefined,
    [unreadNews],
  );

  // Query Studio history belongs to this user (keyed by oid in this browser).
  useEffect(() => setHistoryOwner(me.user.oid), [me.user.oid]);

  // Server preferences win once per session load.
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    setOrgDefaults(me.defaults);
    hydratePrefs(me.prefs);
  }, [me.prefs, me.defaults]);

  // <html> attributes the tokens and shell.css key off.
  useEffect(() => {
    document.documentElement.dataset.nav = collapsed ? 'collapsed' : 'expanded';
  }, [collapsed]);
  useEffect(() => {
    document.documentElement.dataset.mode = arm.armed ? 'armed' : 'read';
    return () => {
      document.documentElement.dataset.mode = 'read';
    };
  }, [arm.armed]);

  const refreshMe = useCallback(
    () => queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
    [queryClient],
  );

  const extend = useCallback(async () => {
    try {
      const { armedUntil } = await api('/auth/arm/extend', { method: 'POST', schema: ExtendResponse });
      queryClient.setQueryData(meQuery.queryKey, (old) =>
        old ? { ...old, armedUntil, armExtended: true } : old,
      );
      toast({ tone: 'ok', title: `Write access extended until ${timeOf(armedUntil)}` });
    } catch (e) {
      toast({ tone: 'crit', title: 'Write access was not extended', description: errorDescription(e) });
    }
  }, [queryClient, toast]);

  const disarm = useCallback(async () => {
    try {
      await api('/auth/disarm', { method: 'POST' });
      queryClient.setQueryData(meQuery.queryKey, (old) =>
        old ? { ...old, mode: 'read' as const, armedUntil: null } : old,
      );
      toast({ tone: 'info', title: 'Write access ended', description: 'You’re back in read-only mode.' });
      void refreshMe();
    } catch (e) {
      toast({
        tone: 'crit',
        title: 'Write access is still on',
        description: <>{errorDescription(e)} Try Disarm again, or sign out.</>,
      });
    }
  }, [queryClient, refreshMe, toast]);

  const onArm = useCallback(async (request: ArmRequest) => {
    // Come back to the same page (and any open playbook drawer) after step-up.
    const returnTo = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
    const { redirect } = await api(`/auth/arm?returnTo=${returnTo}`, {
      method: 'POST',
      body: request,
      schema: RedirectResponse,
    });
    browser.assign(redirect);
  }, []);

  const signOut = useCallback(async () => {
    try {
      const { redirect } = await api('/auth/logout', { method: 'POST', schema: RedirectResponse });
      // Nothing the user ran stays behind for the next person on this browser.
      forgetAllHistory();
      browser.assign(redirect);
    } catch (e) {
      toast({ tone: 'crit', title: 'Sign-out did not complete', description: errorDescription(e) });
    }
  }, [toast]);

  // Five minutes left: one toast offering Extend. At expiry the UI disarms and re-reads the session.
  const warned = useRef(false);
  const wasArmed = useRef(arm.armed);
  const nearExpiry = arm.armed && arm.remainingMs <= WARN_BEFORE_MS;
  useEffect(() => {
    if (!arm.armed) warned.current = false;
    if (nearExpiry && !warned.current) {
      warned.current = true;
      toast({
        tone: 'warn',
        title: 'Write access ends in 5 minutes',
        description: arm.canExtend
          ? 'Extend once without signing in again.'
          : 'Arm again when it ends if you still need it.',
        action: arm.canExtend ? { label: 'Extend', onClick: () => void extend() } : undefined,
        duration: 60_000,
      });
    }
    if (wasArmed.current && !arm.armed && me.mode === 'armed') {
      toast({
        tone: 'info',
        title: 'Write access ended',
        description: 'The time you chose ran out. You’re read-only again.',
      });
      void refreshMe();
    }
    wasArmed.current = arm.armed;
  }, [arm.armed, arm.canExtend, nearExpiry, me.mode, extend, refreshMe, toast]);

  // Ctrl/⌘K anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Remember visited content pages for the palette's Recent group.
  const knownHrefs = useMemo(
    () => new Set((nav.data?.sections ?? []).flatMap((s) => s.items.map((i) => i.href))),
    [nav.data],
  );
  useEffect(() => {
    if (pathname !== '/' && knownHrefs.has(pathname)) pushRecent(pathname);
  }, [pathname, knownHrefs]);

  const shell: ShellApi = useMemo(
    () => ({
      arm,
      openArmDialog: () => setArmDialogOpen(true),
      openPalette: () => setPaletteOpen(true),
      extend,
      disarm,
      signOut,
    }),
    [arm, extend, disarm, signOut],
  );

  return (
    <SessionContext.Provider value={me}>
      <ShellContext.Provider value={shell}>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-(--af-z-palette) focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:font-semibold focus:text-on-accent"
        >
          Skip to content
        </a>
        <SessionRail
          me={me}
          onOpenPalette={() => setPaletteOpen(true)}
          armControl={
            <ArmControl
              canArm={me.canArm}
              authMode={me.authMode}
              maxMinutes={me.armMaxMinutes}
              arm={arm}
              tenantName={me.tenant.name}
              dialogOpen={armDialogOpen}
              onDialogOpenChange={setArmDialogOpen}
              onArm={onArm}
              onExtend={extend}
              onDisarm={disarm}
            />
          }
          userMenu={<UserMenu me={me} onSignOut={() => void signOut()} />}
          indicators={<BreakingPill count={news.data?.breakingUnread ?? 0} />}
        />
        <NavRail
          sections={nav.data?.sections}
          loading={nav.isPending}
          collapsed={collapsed}
          onToggle={() => updatePrefs({ navCollapsed: !collapsed })}
          closedSections={closedSections}
          counts={navCounts}
          onToggleSection={(key) =>
            setOpenSections((open) => (open.includes(key) ? open.filter((k) => k !== key) : [...open, key]))
          }
        />
        <main
          id="main"
          tabIndex={-1}
          className="min-h-dvh pt-(--af-layout-rail-h) pb-(--af-layout-dock-h) pl-(--af-layout-nav-w) outline-none transition-all duration-(--af-motion-base) nav-collapsed:pl-(--af-layout-nav-w-collapsed)"
        >
          <div className="mx-auto w-full max-w-(--af-layout-content-max) px-8 pt-7 pb-12">
            <EmergencyBanner />
            {nav.isError && (
              <div className="mb-6">
                <ErrorState
                  compact
                  title="Navigation didn’t load"
                  message={(nav.error as Error).message}
                  code={nav.error instanceof ApiRequestError ? nav.error.code : undefined}
                  correlationId={nav.error instanceof ApiRequestError ? nav.error.correlationId : undefined}
                  action={
                    <Button size="sm" onClick={() => void nav.refetch()}>
                      Try again
                    </Button>
                  }
                />
              </div>
            )}
            {children}
          </div>
        </main>
        <RunDock trailing={<DevToolbar me={me} />} />
        <Inspector />
        <PlaybookDrawerMount />
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          sections={nav.data?.sections}
          canArm={me.canArm}
        />
      </ShellContext.Provider>
    </SessionContext.Provider>
  );
}

/** Gate: nothing renders until GET /api/me answers; a 401 is already on its way to sign-in. */
export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  if (session.isPending) return <Splash message="Checking your session…" />;
  if (session.isError) {
    const err = session.error;
    if (err instanceof ApiRequestError && err.status === 401 && err.signingIn)
      return <Splash message="Taking you to sign-in…" />;
    if (err instanceof ApiRequestError && err.status === 401) {
      // Ended while nobody was using the tab: signing in again is the person's call (lib/api.ts). Or the tab just came
      // back from a sign-in and the session still isn't accepted — following it again would loop (lib/sign-in-guard.ts).
      const loop = !maySignInAutomatically();
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-8 p-8">
          <Brand size="lg" />
          <ErrorState
            title={loop ? 'Sign-in didn’t finish' : 'You’re signed out'}
            message={err.message}
            hint={
              loop
                ? 'Sign in again. If this screen comes back, give a portal administrator the reference.'
                : err.hint
            }
            code={err.code}
            correlationId={err.correlationId}
            action={
              <Button onClick={() => browser.assign(loginUrl(err.login ?? '/auth/login'))}>
                Sign in again
              </Button>
            }
          />
        </div>
      );
    }
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-8 p-8">
        <Brand size="lg" />
        <ErrorState
          title="AdminForge couldn’t load your session"
          message={err.message}
          hint={err instanceof ApiRequestError ? err.hint : undefined}
          code={err instanceof ApiRequestError ? err.code : undefined}
          correlationId={err instanceof ApiRequestError ? err.correlationId : undefined}
          action={<Button onClick={() => void session.refetch()}>Try again</Button>}
        />
      </div>
    );
  }
  return <SignedInShell me={session.data}>{children}</SignedInShell>;
}
