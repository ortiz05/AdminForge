# ADR-007: Design tokens in TypeScript compiled to CSS variables

Status: accepted (2026-10-15)

> Context, options and consequences back-filled on 2026-10-21 from the master plan it came from
> (`docs/plans/2026-10-15-adminforge-master-plan.md` §3, §6.1, §6.8). The decision is unchanged; the palette itself
> was renamed by the plan's Revision 2 (steel, daylight, contrast).

## Context

The look must be centrally controlled. AdminForge is an operations console engineers use for hours: colour is
reserved for meaning — state, and above all the armed (write) state, which must be unmistakable and used for nothing
else. Many people (and Claude Code) add screens and content, so a page must not be able to style itself, contrast must
be checked by a test rather than by eye, and an administrator should be able to adjust a few things (the accent, the
radius scale) without a release.

## Options considered

- **A component library's theme (Fluent UI).** Rejected: AdminForge would look like the Azure portal, and the theme
  doesn't stop a page from using any colour.
- **CSS-in-JS.** Rejected: styles spread through components, harder to audit for raw colours, and runtime cost.
- **Tailwind with its default palette and scales.** Rejected: every colour and arbitrary value stays one class away.
- **Tokens in TypeScript compiled to CSS variables**, Tailwind with its defaults removed so only token utilities
  exist, variants in recipes. Chosen: typed, testable, one file to change the whole look.

## Decision

tokens.ts → --af-* variables, Tailwind with defaults removed, recipes, runtime overrides.

## Consequences

- Contrast is unit-tested; pages cannot style themselves. The look changes in one file,
  `portal/packages/design-tokens/src/tokens.ts`; components get variants from recipes in `@adminforge/ui`.
- Raw colours and arbitrary Tailwind values are refused by ESLint, the guard test (`tests/guards/design-tokens.test.ts`)
  and Claude Code's after-edit hook, all from one pattern list (`tooling/lint/design-token-patterns.mjs`); the plan's
  Stylelint was not needed.
- Ember (`armed`) means write mode and nothing else (CLAUDE.md rule 5).
- Runtime overrides (Admin → Appearance) cover an allow-listed set of tokens, are refused below 4.5:1 contrast, are
  audited, and are served as `/api/appearance.css` after the built tokens.
- Visual baselines in steel and daylight catch drift; the `changing-the-design-system` skill describes how to change
  the look.
