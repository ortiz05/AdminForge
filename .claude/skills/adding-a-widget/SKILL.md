---
name: adding-a-widget
description: Use when an AdminForge page needs a visualisation or interaction that the existing widgets (kpi, table, chart, list, keyValue, statusGrid, timeline, markdown, actionBar, licenceGate, probeStatus) cannot express.
---

# Adding a widget

## Overview

Widgets are generic building blocks in `portal/packages/widgets/src/widgets/<kebab-name>/` (`schema.ts`, `Widget.tsx`,
`fixtures.ts`, `index.ts`); the `widget:` type is camelCase (`status-grid/` → `statusGrid`). Each one is registered
twice: its config schema in `src/schemas.ts` (`WIDGET_SCHEMAS`, which `registerWidgetSchema`s it with
`@adminforge/schemas` so the CLI, API and content tests validate it) and its definition in `src/registry.ts`
(`WIDGETS`, used by the page renderer, which wraps every component in an error boundary). The component uses only
`@adminforge/ui` primitives and design tokens.

## When not to use

- A config option on an existing widget is enough — prefer that (and document it in `docs/widgets.md`).
- One page's special case (`usersHeatmap`) — widgets are generic; express the page in content
  (`adding-a-page-or-report`).
- A whole screen that isn't content-driven → `adding-a-coded-screen`; a look-and-feel change everywhere →
  `changing-the-design-system`.

## Steps

1. Copy the closest widget folder to `src/widgets/<kebab-name>/`; name the type in camelCase.
2. `schema.ts`: zod config built on `blockShape` / `DataRef` from `src/lib/schema-common.ts` (keep it declarative;
   expressions only as `${…}` strings evaluated with the row/value/params scope). A change to an existing widget's
   schema that isn't backward-compatible (a key removed, renamed, narrowed or made required) bumps
   `CONTENT_SCHEMA_VERSION` in `portal/packages/schemas/src/schema-version.ts` in the same change; additive, optional
   keys don't.
3. `index.ts`: the `WidgetDefinition` (`type`, `schema`, `component`, default `span`, `needsData`).
4. Register it: add the schema to `WIDGET_SCHEMAS` (and the re-export list) in `src/schemas.ts`, the definition to
   `WIDGETS` in `src/registry.ts`, and export the config type and `<type>Fixtures` from `src/index.ts`. The registry
   wraps the component with `withWidgetBoundary` (named by the block's `title`, or the key in `LABEL_KEY`; an untitled
   block is "This part of the page", never its type — `cantBeShownTitle`, `blockLabel`): a block that fails while it
   renders shows "<name> couldn't be shown" with a reference and Try again, and the rest of the page keeps working. If
   the block's label key isn't `title`, add it to `LABEL_KEY` there.
5. `Widget.tsx`: loading / empty / error states, `ProvenanceFooter`, keyboard access, status = icon + label (never
   colour alone). Values that may contain HTML are shown as text. A templated link target (`href` from data or
   content) goes through `safeUrl` (`@adminforge/ui`, `portal/packages/ui/src/lib/links.ts`) before `runtime.Link`:
   only `https://`, `http://`, `mailto:`, an in-app `/path` or `#anchor` becomes a link; anything else stays text.
   Charts follow the dataviz rules: one y-axis, ≤ 6 series, legend for ≥ 2, table toggle. Content actions use
   `ActionButton`, `PlaybookButton` and `ActionMenuItem` from `src/lib/actions.tsx`, so write playbooks show the lock or
   the ember dot.
6. Document the keys in `docs/widgets.md` (with a YAML example).
7. Tests: `tests/component/widgets/<type>.test.tsx` (render, keyboard, `axe` = 0 violations, an unsafe `href` that
   stays text); add the type to the list in `tests/component/widgets/registry.test.tsx`; a content example in
   `tests/fixtures` if needed.
8. **No eval in the browser** (`CLAUDE.md` non-negotiable 12; `docs/onboarding/07-web-guide.md` › Under the security
   policy): no `eval`, `new Function`, inline `<script>` or a library that needs them. After adding a dependency, run
   `pnpm build && pnpm test:e2e:prod` (`tests/e2e/prod/csp-no-eval.spec.ts`) — in your own checkout, never one a
   running service serves.
9. Check: widgets and web typecheck, component tests, `pnpm guard` (tokens), and screenshot it in steel and daylight;
   then `design-reviewer`.

## Done when

- [ ] Registered in `WIDGET_SCHEMAS` and `WIDGETS`; `docs/widgets.md` documents every key with an example
- [ ] Component tests pass with `axe` at 0 violations, keyboard access and the registry list updated
- [ ] Loading, empty and error states exist; links pass `safeUrl`; status is icon + label
- [ ] `pnpm guard` and the widgets/web typechecks pass; screenshots in steel and daylight looked at
- [ ] A new dependency passed `pnpm test:e2e:prod`; `design-reviewer` ran and its findings are fixed or answered

## Common mistakes

| Mistake                               | Fix                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| Page-specific widget (`usersHeatmap`) | Generic widget + config                                                      |
| Raw colours / arbitrary Tailwind      | Tokens only; add tokens in design-tokens if truly needed                     |
| Using `armed`/ember for emphasis      | Ember means write mode only                                                  |
| A templated `href` passed straight on | `safeUrl` first; `javascript:`, `//host` and `/\host` must stay text         |
| A dependency that uses or probes eval | Refused by the CSP: pick another, or turn the probe off (`disableEvalProbe`) |
| Narrowing a widget key without a bump | `CONTENT_SCHEMA_VERSION` + 1 in the same change, and say so in the changelog |

## See also

- `docs/widgets.md` (every widget key), `portal/packages/widgets/src/registry.ts`
- `changing-the-design-system`, `adding-a-coded-screen`, `.claude/agents/design-reviewer.md`
