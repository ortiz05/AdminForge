---
name: adding-a-coded-screen
description: Use when AdminForge needs a React screen the content renderer can't express — an app feature like runs, schedules, approvals, the reports catalogue, Query Studio, settings or audit — or a change to one of those screens in portal/apps/web.
---

# Adding a coded screen

## Overview

The SPA (`portal/apps/web`) is React with TanStack Router (file routes) and TanStack Query, Tailwind on the design
tokens, `@adminforge/ui` for components and `@adminforge/widgets` for content blocks. A coded screen is a route file in
`src/routes/`, a feature folder with its data module and components, component and e2e tests, and — when it needs data
the API doesn't serve yet — an API route. `docs/onboarding/07-web-guide.md` is the full guide; this is the path
through it.

## When not to use

- Lists, dashboards, reports and entity views are content at `/p/$key` → `adding-a-page-or-report`. Ask first whether
  the renderer can express it; a coded screen is for app features (runs, schedules, Query Studio, settings).
- A block on content pages that the widgets can't draw → `adding-a-widget` (generic, reusable in YAML).
- A change of look everywhere → `changing-the-design-system`.
- Anything that changes the tenant from a component — never: writes go through a playbook (preview → confirm → run).

## Steps

1. **Reuse first.** Find the closest screen (`rg -l "createFileRoute" portal/apps/web/src/routes`) and copy its shape:
   `src/routes/reports.tsx` → `src/reports/` (`catalog.ts` data, `search.ts` URL params, `ReportsPage.tsx`, one
   component per file).
2. **Route:** `src/routes/<path>.tsx` with `createFileRoute`, a `validateSearch` that bounds every search param (type,
   length, pattern — `routes/monitoring.tsx`) and a component that renders the page. `routeTree.gen.ts` is generated
   (`pnpm --filter @adminforge/web routes`, also run by the web typecheck) — never edit it.
3. **Data module** (`src/<feature>/<name>.ts`): `queryOptions(...)` objects and mutation functions; query keys start
   with the feature. All HTTP through `api()` (`src/lib/api.ts`: CSRF header, background polling flag, errors as
   `ApiRequestError`) with a parser — the zod contracts from `@adminforge/schemas` on lazily loaded screens. After a
   mutation invalidate what changed; live updates come from the API's events (`src/app/live-updates.ts`), polling is
   only a slow fallback. Missing backend → `adding-an-api-route` first (contract in `@adminforge/schemas`).
4. **URL state:** anything worth sharing or coming back to (selection, filters, open panel) lives in validated search
   params; opening a panel adds a history entry so Back closes it; filters replace the entry; deep links work on a
   fresh load.
5. **Look and behaviour:** design tokens only and existing `@adminforge/ui` components (`PageHeader`, `DataTable`,
   `Panel`, `Drawer`, `EmptyState`, `ErrorState`, …); ember only for write mode. Loading (`Skeleton`), empty (what's
   missing and the way out), error (`ErrorState` with the API's message, hint and reference), no-permission and
   unlicensed states. Hide or disable what the person's roles can't do, and say which role. Links built from data go
   through `AppLink` / `useNavigateHref` (`src/lib/links.tsx`), which apply `safeUrl`. Copy: sentence case, buttons
   say what happens, no env keys, endpoints or header names.
6. **Navigation:** an item in `portal/content/navigation.yaml` with `href: /<path>` (bump its `version`; `roles:` on
   the section for admin-only screens). The API enforces access anyway.
7. **Size and security:** heavy screens and libraries load lazily with their route (initial load ≤ 250 KB gzip,
   checked in CI). No `eval`, `new Function` or inline script, and `lib/no-eval.ts` stays the first import in
   `main.tsx` (`docs/onboarding/07-web-guide.md` › Under the security policy).
8. **Tests:** `tests/component/<feature>/…` (jsdom, keyboard, `axe` at 0 violations, focus returns to what opened a
   panel); `tests/e2e/<feature>.spec.ts` with handlers in `tests/e2e/support/mock-api.ts` (or a feature mock such as
   `tests/support/web/mock-automation.ts`) and payloads in `tests/support/web/fixtures/`; screenshot baselines in steel
   and daylight under `tests/e2e/__screenshots__/` for the specs you changed (e2e uses port 5173 — one runner at a
   time).
9. **Check:** `pnpm --filter @adminforge/web typecheck`, the component project, the e2e spec, `pnpm guard`,
   `pnpm lint`; look at every screenshot; a new dependency or bundling change also gets
   `pnpm build && pnpm test:e2e:prod` — in your own checkout, never one a running service serves. Then
   `design-reviewer` (and `security-reviewer` when the API changed).

## Done when

- [ ] Route with bounded `validateSearch`; data through `api()` with a parser and `queryOptions`; shareable state in
      the URL
- [ ] Loading, empty, error, no-permission and unlicensed states exist and read well; tokens and `@adminforge/ui` only
- [ ] Component tests (axe 0, keyboard, focus return) and an e2e spec pass; you looked at the steel and daylight
      screenshots
- [ ] The web typecheck, `pnpm guard` and `pnpm lint` pass; the initial-load budget holds
- [ ] `design-reviewer` ran (plus `security-reviewer` for API changes) and findings are fixed or answered

## Common mistakes

| Mistake                                              | Fix                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| A coded screen for what is really a list or report   | Content at `/p/$key` (`adding-a-page-or-report`)                        |
| `fetch` or a raw JSON body in a component            | `api()` + a parser in the feature's data module                         |
| Filters or the open item only in component state     | Search params validated by the route; Back closes panels                |
| Raw JSON, a stack trace or a header name in an error | `ErrorState` / `errorText()` with the API's message, hint and reference |
| A heavy library in the initial bundle                | Load it lazily with the route                                           |
| `--update-snapshots` on every spec                   | Only the specs your change meant to move, after looking at each image   |

## See also

- `docs/onboarding/07-web-guide.md` (stack, data fetching, URL state, accessibility, copy)
- `adding-an-api-route`, `adding-a-widget`, `changing-the-design-system`, `.claude/agents/design-reviewer.md`
