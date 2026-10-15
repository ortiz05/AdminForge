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
(`WIDGETS`, used by the page renderer). The component uses only `@adminforge/ui` primitives and design tokens. **First
check whether a config option on an existing widget is enough** — prefer that.

## Steps

1. Copy the closest widget folder to `src/widgets/<kebab-name>/`; name the type in camelCase.
2. `schema.ts`: zod config built on `blockShape` / `DataRef` from `src/lib/schema-common.ts` (keep it declarative;
   expressions only as `${…}` strings evaluated with the row/value/params scope).
3. `index.ts`: the `WidgetDefinition` (`type`, `schema`, `component`, default `span`, `needsData`).
4. Register it: add the schema to `WIDGET_SCHEMAS` (and the re-export list) in `src/schemas.ts`, the definition to
   `WIDGETS` in `src/registry.ts`, and export the config type and `<type>Fixtures` from `src/index.ts`.
5. `Widget.tsx`: loading / empty / error states, `ProvenanceFooter`, keyboard access, status = icon + label (never colour
   alone). Charts follow the dataviz rules: one y-axis, ≤ 6 series, legend for ≥ 2, table toggle.
6. Document the keys in `docs/widgets.md` (with a YAML example).
7. Tests: `tests/component/widgets/<type>.test.tsx` (render, keyboard, `axe` = 0 violations); add the type to the list
   in `tests/component/widgets/registry.test.tsx`; a content example in `tests/fixtures` if needed.
8. Check: widgets/web typecheck, component tests, `pnpm guard` (tokens), and screenshot it in steel and daylight.

## Common mistakes

| Mistake                               | Fix                                                      |
| ------------------------------------- | -------------------------------------------------------- |
| Page-specific widget (`usersHeatmap`) | Generic widget + config                                  |
| Raw colours / arbitrary Tailwind      | Tokens only; add tokens in design-tokens if truly needed |
| Using `armed`/ember for emphasis      | Ember means write mode only                              |
