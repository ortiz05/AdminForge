---
name: changing-the-design-system
description: Use when asked to change AdminForge's look and feel — colours, accent, fonts, spacing, radius, density, a component's style everywhere, or to add a theme.
---

# Changing the design system

## Overview

One source of truth: `portal/packages/design-tokens/src/tokens.ts` → `--af-*` CSS variables + a Tailwind theme with the
defaults removed. Component variants live in `portal/packages/ui/src/recipes/*.ts`. Pages never style themselves.
Admins can override a small allowlist at runtime on `/appearance` — prefer that for tenant branding.

| Change                                           | Where                                           |
| ------------------------------------------------ | ----------------------------------------------- |
| A colour everywhere                              | semantic token in `themes.<name>` (tier 2)      |
| A shape/size everywhere (e.g. all panel corners) | `components` (tier 3) or `scale`                |
| One component's variants                         | its recipe in `portal/packages/ui/src/recipes/` |
| A new theme                                      | add to `THEME_NAMES`, `themeMeta`, `themes`     |

## Steps

1. Edit `tokens.ts`; `pnpm --filter @adminforge/design-tokens build` (dev server watches).
2. `pnpm --filter @adminforge/tests exec vitest run --project unit unit/design-tokens` — contrast targets are tests
   (fg ≥ 7:1, others ≥ 4.5:1). If one fails, change the colour, never the threshold.
3. Chart palettes: validate with the dataviz palette validator before changing.
4. Screenshot `/design` and `/` in every theme × density (`pnpm test:e2e` runs the visual specs in `tests/e2e`), look
   at them, then update baselines (`pnpm --filter @adminforge/tests exec playwright test -c e2e/playwright.config.ts
--update-snapshots`) only when the change is intended.

## Rules

- Ember (`armed`) is reserved for write mode.
- No raw colours or arbitrary Tailwind values anywhere in UI code (`pnpm guard`).
