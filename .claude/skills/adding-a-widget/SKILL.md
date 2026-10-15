---
name: adding-a-widget
description: Use when an AdminForge page needs a visualisation or interaction that the existing widgets (kpi, table, chart, list, keyValue, statusGrid, timeline, markdown, actionBar, licenceGate, probeStatus) cannot express.
---

# Adding a widget

## Overview

Widgets are generic building blocks in `portal/packages/widgets/src/<type>/` (`schema.ts`, `Widget.tsx`, `fixtures.ts`,
`index.ts`). The schema is registered for server-side validation; the component uses only `@adminforge/ui` primitives
and design tokens. **First check whether a config option on an existing widget is enough** — prefer that.

## Steps

1. Copy the closest widget folder; name the type in camelCase.
2. `schema.ts`: zod config (keep it declarative; expressions only as `${…}` strings evaluated with the row/value/params
   scope). Register it in the package index so `registerWidgetSchema` runs in both web and API.
3. `Widget.tsx`: loading / empty / error states, `ProvenanceFooter`, keyboard access, status = icon + label (never colour
   alone). Charts follow the dataviz rules: one y-axis, ≤ 6 series, legend for ≥ 2, table toggle.
4. Document the keys in `docs/widgets.md` (with a YAML example).
5. Tests: `tests/component/widgets/<type>.test.tsx` (render, keyboard, `axe` = 0 violations); a content example in
   `tests/fixtures` if needed.
6. Check: widgets/web typecheck, component tests, `pnpm guard` (tokens), and screenshot it in steel and daylight.

## Common mistakes

| Mistake                               | Fix                                                      |
| ------------------------------------- | -------------------------------------------------------- |
| Page-specific widget (`usersHeatmap`) | Generic widget + config                                  |
| Raw colours / arbitrary Tailwind      | Tokens only; add tokens in design-tokens if truly needed |
| Using `armed`/ember for emphasis      | Ember means write mode only                              |
