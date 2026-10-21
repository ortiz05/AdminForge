# 7. Web guide

How the React SPA (`portal/apps/web`) is put together, so every screen fetches, looks, behaves and reads the same way.
First ask: **is this a content page?** Lists, dashboards, reports and entity views are YAML rendered by the generic
renderer at `/p/$key` — no React. Coded screens are for app features the renderer can't express (runs, schedules,
reports catalogue, Query Studio, settings).

## Stack

React with TanStack Router (file routes) and TanStack Query, Vite, Tailwind with the AdminForge design tokens, the
`@adminforge/ui` component library, and `@adminforge/widgets` for content widgets.

## Anatomy of a coded screen

```text
portal/apps/web/src/routes/reports.tsx      route: path, search-param validation, renders the page component
portal/apps/web/src/reports/
├── catalog.ts                              API calls + parsers + queryOptions (the screen's data layer)
├── search.ts                               URL search params: validate, defaults, helpers
├── ReportsPage.tsx                         the page: header, KPIs, filters, table
├── ReportDetails.tsx, ScheduleForm.tsx     focused parts, one component each
tests/component/reports/…                   component tests (jsdom, axe)
tests/e2e/reports.spec.ts + __screenshots__ end-to-end and visual baselines (mock API)
```

`routeTree.gen.ts` is generated (`pnpm --filter @adminforge/web routes`, also run by the web typecheck) and git-ignored
— never edit it by hand.

## Data fetching

- One data module per feature exports `queryOptions(...)` objects and mutation functions; components call `useQuery`
  / `useMutation` with them. Query keys start with the feature (`['reports', …]`, `['schedules']`).
- All HTTP goes through `api()` in `src/lib/api.ts`: it adds the CSRF header to non-GET requests, marks background
  polling with `X-AdminForge-Background: 1` (so it doesn't keep a session alive), turns failures into
  `ApiRequestError { code, message, hint, correlationId }`, and parses the body with a **parser**.
- Parsers: the shell (`/api/me`, `/api/nav`, error bodies) uses hand-written guards in `src/lib/contracts.ts` to keep
  zod out of the initial bundle. Lazily loaded screens use the zod contracts from `@adminforge/schemas` or the small
  lenient readers in `src/runs/json.ts` (`rec`, `arr`, `str`, `parser`), which tolerate added fields.
- Live updates: the API publishes events over SSE; `src/app/live-updates.ts` invalidates the matching queries. Prefer
  events; where a screen also polls (schedules, probes every 60 s) it's a slow fallback, not the mechanism.
- After a mutation, invalidate the queries whose data changed; don't patch caches by hand unless the screen needs it.
- Watch the **initial-load budget** (≤ 250 KB gzip JS, checked in CI): heavy screens and libraries load lazily with
  their route.

## Under the security policy

The API serves the app with `script-src 'self'` and no `unsafe-eval` (`SECURITY.md` › Deployment, storage and
network); Firefox and Chrome log every violation in the console, where it hides real problems.

- No `eval`, `new Function`, `setTimeout` with a string, inline `<script>` or `javascript:` URLs — and no library that
  needs them. Before you adopt a dependency, search its built output for `new Function(`, a bare `Function(` and
  `eval(` — the test below only sees the code that runs on the page it loads.
- Zod 4 probes `Function('')` to decide whether to compile validators. `src/main.tsx` imports `lib/no-eval.ts` first,
  which calls `disableEvalProbe()` from `@adminforge/schemas`; keep it the first import. It adds only Zod's
  configuration to the initial bundle — the schemas themselves still load lazily with the screens that use them.
- Styles may be inline (Radix and Monaco inject them; `style-src 'unsafe-inline'` is an accepted risk) — scripts may
  not.
- `tests/e2e/prod/csp-no-eval.spec.ts` loads a page of the production build under the same policy and fails on any
  violation; run `pnpm build && pnpm test:e2e:prod` when you add a dependency or change bundling (a local build never
  reaches production, which runs the app image).

## URL state

Anything a person would want to share or come back to — selected item, filters, search, open panel or form — lives in
the URL's search params, validated by the route (`validateSearch`). Opening a panel adds a history entry so **Back**
closes it; changing a filter replaces the entry. Deep links must work on a fresh load.

## Look and feel

- **Design tokens only.** Token utilities (`bg-panel`, `text-fg-2`, `border-line`, `h-(--af-control-h)`), never raw
  colours or arbitrary Tailwind values — ESLint and the guard tests reject them. A missing token is added in
  `portal/packages/design-tokens/src/tokens.ts` (the `changing-the-design-system` skill), not worked around.
- **Ember (`armed`) means write mode** and nothing else. Creating a schedule or saving a view is not write mode.
- **Reuse `@adminforge/ui`**: `DataTable`, `PageHeader`, `Panel`, `KpiStrip`/`Kpi`, `Badge`, `StatusPill`, `Button`,
  `Select`, `Switch`, `TextField`, `SegmentedControl`, `Drawer`, `Dialog`, `ConfirmDialog`, `Icon`, `Skeleton`,
  `EmptyState`, `ErrorState`, `useToast`. Variants are `tv()` recipes in the ui package. A new primitive goes into
  `@adminforge/ui` with a component test, not into a feature folder.
- Themes: steel (dark, default), daylight (light) and contrast; densities comfortable and compact. Check your screen
  in steel and daylight at least.
- Icons are Phosphor names in kebab-case (`chart-bar`, `calendar-check`).

## Behaviour every screen gets right

- **Sign-in on 401.** `api()` sends the browser to sign in only for a request the person made, and at most once per tab
  within a minute (`lib/sign-in-guard.ts`): a second 401 right after the round trip shows the error with "Sign in
  again" instead of looping through single sign-on. Auxiliary lookups (capabilities, badges, pollers) pass
  `background: true` so they never start a sign-in themselves. A page whose data needs a fresh Microsoft sign-in
  (`reauth`) shows one "Sign in again" banner; its widgets show a quiet note instead of each repeating the error.
- **Loading, empty and error states.** `Skeleton` while loading; `EmptyState` that says what's missing and offers the
  way out ("Clear filters", "Schedule a report"); `ErrorState` / `errorText()` / `errorDescription()`
  (`src/lib/errors.tsx`) to show the API's message, hint and reference — never raw JSON.
- **Roles.** Hide or disable actions the person can't take, and say why ("Scheduling needs the Portal Operator
  role"). The API enforces it anyway; the UI just shouldn't offer dead ends.
- **Licences.** Content declares `requires.licences`; the UI shows "Requires …" and explains instead of failing.
- **Write mode.** Anything that changes the tenant goes through a playbook (preview → confirm → run) — never a direct
  call from a component.

## Accessibility

- Every control has a visible or accessible label; icon-only buttons have `aria-label`.
- Everything works with the keyboard: rows open with Enter, Escape closes, and focus **returns** to what opened a panel
  or dialog. The ui `Dialog`, `Drawer`, `ConfirmDialog` and command palette do this for you; a custom panel must do it
  itself.
- Status is never colour alone — pair it with text or an icon (`StatusPill`).
- Respect reduced motion; keep contrast within the tokens.
- Component tests run `axe` (`tests/component/axe.ts`); keep them passing.

## Copy

Sentence case, plain verbs, named after what people control. A button says what happens ("Create schedule", not
"Submit") and the toast uses the same words ("Schedule created"). Errors say what happened and what to do. No
internal names (env keys, endpoint paths, header names) in the UI.

## Screenshots are part of the change

UI changes ship with Playwright screenshots in **steel and daylight** (and a narrow viewport when layout changes),
committed as baselines under `tests/e2e/__screenshots__/`. Look at every image before you commit it — overflow,
clipped text, alignment, contrast. Only update baselines your change intentionally altered (`--update-snapshots` on
the spec you changed). New endpoints need handlers in the mock API (`tests/e2e/support/mock-api.ts`, or a feature mock
such as `tests/support/web/mock-automation.ts`) and payloads in `tests/support/web/fixtures/`.
`pnpm build && pnpm test:e2e:prod` smoke-tests the production bundle (charts, the security policy). See
[Testing](09-testing.md#end-to-end-and-visual). Content pages are screenshotted too when a new section or dashboard
ships: look at KPI labels — at `span: 2` they cut off past about 22 characters ([widgets](../widgets.md#kpi)).

## Before you open the PR

- [ ] Content page instead? (If yes, it's YAML — [Content guide](08-content-guide.md).)
- [ ] Data module with `queryOptions`, `api()` + parser, invalidation on mutation and events; lazy-loaded if heavy
- [ ] URL holds shareable state; Back closes panels
- [ ] Tokens only; existing ui components; ember only for write mode
- [ ] Nothing that needs `eval` or inline script; `lib/no-eval.ts` still first in `main.tsx`
- [ ] Loading, empty, error, no-permission and unlicensed states
- [ ] Keyboard, focus return, labels, axe clean
- [ ] Screenshots in steel + daylight reviewed; mock API handlers and fixtures for new endpoints
- [ ] `design-reviewer` agent run for visible changes

## Read next

[Content guide](08-content-guide.md).
