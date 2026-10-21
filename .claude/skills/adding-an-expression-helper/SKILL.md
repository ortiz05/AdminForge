---
name: adding-an-expression-helper
description: Use when AdminForge content needs a new $function in its expressions (a JSONata helper such as $attach, $pluck or $tableRows) — a native row operation a transform can't do within its budget, a date or id helper, or a new encoder for user data.
---

# Adding an expression helper

## Overview

Helpers are registered on every compiled expression in `portal/packages/expressions/src/helpers.ts`
(`registerHelpers`, listed in `HELPER_NAMES`) and run wherever expressions do: the API (datasources, transforms,
playbooks, schedules) and the browser (widget, header and action expressions). Each is also exported as a plain
function so server code can call the same logic. The injection lint (`taint.ts`) and the size limits (`limits.ts`,
`budget.ts`) must know what a helper does with user data. What exists and how to use it:
`docs/content-recipes.md` › Expression helpers.

## When not to use

- A JSONata built-in or an existing helper does it within the budget — check the recipes and
  `rg "export function" portal/packages/expressions/src/helpers.ts` first.
- One page's logic → a transform in that page; a helper must be generic.
- A new encoder (a way to make user data safe in some kind of text) is a security change: it goes in the taint
  analysis's encoder list with a `security-reviewer` pass, never as an ordinary helper.

## Steps

1. **Write the plain function** in `helpers.ts` with a doc comment that shows the call
   (`` `$withShare(rows, 'cost', 'share')`: … ``). Validate arguments and throw `$<name>: <what is wrong>` errors.
   No `node:` imports at module level (the package bundles for the browser — look builtins up at run time as
   `cryptoRandomInt` does) and nothing that needs `eval`.
2. **Rows at scale:** take a `Budget` and check it every `DEADLINE_STRIDE` items; refuse more than `MAX_SEQUENCE`
   items (`limits.ts`); read own properties only, never into functions; cap fields or paths per call (64); build text
   no longer than `MAX_TEXT`.
3. **Register it** in `registerHelpers` (with a JSONata signature string such as `'<xs:a>'`; `budgetOf(this)` for row
   helpers, `scopeNow(this)` for anything that reads the time) and add the name to `HELPER_NAMES`.
4. **Taint** (`portal/packages/expressions/src/taint.ts`): by default a helper's result carries its arguments' user
   data, which is right for row and text helpers. A helper whose result is only a number, a boolean, a date or a new
   id goes in `SAFE_RESULTS`; one that takes text apart goes in `TAKES_APART`; one that can rebuild any character goes
   in `DECODERS`. Add a lint test showing user data through it is still flagged where it lands.
5. **Tests:** `tests/unit/expressions/<helper>.test.ts` (behaviour, argument errors, missing values); a helper meant
   for big lists also gets `tests/unit/expressions/<helper>.scale.test.ts` with the real budget on the largest input
   (`rows-join-helpers.scale.test.ts`).
6. **Document it** in `docs/content-recipes.md` › Expression helpers (what it returns, its limits, an example from real
   content), and mention it where a skill points authors at helpers.
7. **Check:** `pnpm --filter @adminforge/expressions typecheck`, the unit project for `unit/expressions` and the scale
   files one at a time, `pnpm adminforge validate` (all shipped content stays clean), `pnpm guard`; then
   `security-reviewer` (the package is on the security-review list).

## Done when

- [ ] Exported, registered, in `HELPER_NAMES`, documented in `docs/content-recipes.md`
- [ ] Bounded: budget checks, `MAX_SEQUENCE` / `MAX_TEXT` limits, own properties only; no `node:` imports at module
      level
- [ ] The taint analysis classifies it correctly, with a lint test
- [ ] Unit and scale tests pass; `pnpm adminforge validate` is still clean on all content
- [ ] `security-reviewer` ran and its findings are fixed or answered

## Common mistakes

| Mistake                                            | Fix                                                             |
| -------------------------------------------------- | --------------------------------------------------------------- |
| A per-row helper with no deadline check            | Take `budgetOf(this)` and check it every `DEADLINE_STRIDE` rows |
| Marking a text helper "safe" in the taint analysis | Only numbers, booleans, dates and new ids are safe results      |
| `import { randomInt } from 'node:crypto'`          | Look Node builtins up at run time; the browser bundle must load |
| Reading the clock with `new Date()`                | `scopeNow(this)`, so tests and playbook tests can pin `now`     |
| A helper only one page needs                       | Keep it in that page's transform                                |

## See also

- `docs/content-recipes.md` › Expression helpers and › Quoting user data
- `portal/packages/expressions/src/{helpers,taint,limits,budget}.ts`; `.claude/agents/security-reviewer.md`
