---
name: changing-the-design-system
description: Use when asked to change AdminForge's look and feel — colours, accent, fonts, spacing, radius, density, a component's style everywhere, or to add a theme.
---

# Changing the design system

## Overview

One source of truth: `portal/packages/design-tokens/src/tokens.ts` → `--af-*` CSS variables + a Tailwind theme with the
defaults removed. Its header states the direction: cold steel while reading, hot iron when armed — neutral surfaces,
one cool accent, colour reserved for meaning (status, write mode). Component variants live in
`portal/packages/ui/src/recipes/*.ts`. Pages never style themselves.

| Change                                           | Where                                           |
| ------------------------------------------------ | ----------------------------------------------- |
| A colour everywhere                              | semantic token in `themes.<name>` (tier 2)      |
| A shape/size everywhere (e.g. all panel corners) | `components` (tier 3) or `scale`                |
| One component's variants                         | its recipe in `portal/packages/ui/src/recipes/` |
| A new theme                                      | add to `THEME_NAMES`, `themeMeta`, `themes`     |

## When not to use

- Tenant branding: admins override a small allowlist of tokens at runtime on `/appearance` — prefer that.
- One screen looking different → fix the screen to use the shared recipes (`adding-a-coded-screen`), don't add a
  one-off token.
- A new visualisation → `adding-a-widget`.

## Steps

1. Edit `tokens.ts`; `pnpm --filter @adminforge/design-tokens build` (dev server watches).
2. `pnpm --filter @adminforge/tests exec vitest run --project unit unit/design-tokens` — contrast targets are tests
   (fg ≥ 7:1, others ≥ 4.5:1). If one fails, change the colour, never the threshold.
3. Chart palettes: validate with the dataviz palette validator before changing.
4. Screenshot `/design` and `/` in every theme × density (`pnpm test:e2e` runs the visual specs in `tests/e2e`), look
   at them, then update baselines
   (`pnpm --filter @adminforge/tests exec playwright test -c e2e/playwright.config.ts --update-snapshots`) only when the
   change is intended — and say which specs changed.
5. Run `design-reviewer`.

## Done when

- [ ] `tokens.ts` (or a recipe) is the only file that changed the look; `pnpm guard` passes
- [ ] The design-tokens unit tests pass without a lowered threshold
- [ ] You looked at `/design` and `/` in steel and daylight (and the other themes and densities); baselines updated
      only for intended changes
- [ ] `design-reviewer` ran and its findings are fixed or answered

## Common mistakes

| Mistake                                             | Fix                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| Ember (`armed`) for emphasis, a chart or branding   | Ember is reserved for write mode                                          |
| Raw colours or arbitrary Tailwind values in UI code | Token utilities only (`pnpm guard` and ESLint refuse the rest)            |
| Lowering a contrast threshold to make a test pass   | Change the colour                                                         |
| Generating new chart hues                           | Use the validated palette; more than six series fold into "Other"         |
| Updating every baseline after a token change        | Look at each image first; update only the specs your change meant to move |

## See also

- `portal/packages/design-tokens/src/tokens.ts` (header: the direction), `docs/onboarding/07-web-guide.md` › Look and
  feel
- `.claude/agents/design-reviewer.md`, `adding-a-widget`, `adding-a-coded-screen`
