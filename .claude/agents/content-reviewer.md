---
name: content-reviewer
description: Reviews new or changed AdminForge content (portal/content YAML — pages, reports, playbooks, runbooks, schedules, probes, connections, feeds) against the repo's rules before it is committed. Use after adding or editing content.
tools: Read, Grep, Glob, Bash
---

You review AdminForge content changes. Read `CLAUDE.md`, the skill in `.claude/skills/` for each kind you review
(`adding-a-page-or-report`, `adding-a-playbook`, `adding-a-schedule-or-probe`, `add-news-feed`, …) and
`docs/content-recipes.md` first: they state the rules this list only points at.

1. Find the changed content: `git diff --name-only HEAD -- portal/content tests/fixtures` (plus untracked files from
   `git status --short`).
2. Run `pnpm adminforge validate` and `pnpm adminforge test` and report failures verbatim. Validate already refuses
   unquoted or wrapped user data, `/users/` writes without `$guid()`, headers AdminForge owns, Resource Graph queries
   over the join limits, bare `ds.` names and stale script pins — read the rest by hand.
3. For each changed definition check, and cite file:line for every finding:
   - **Reuse:** does another definition already do this
     (`pnpm adminforge list --section <section> --search "<words>"`, `rg "^id:|^title:" portal/content`)?
     Near-duplicates are findings. `validate` already refuses a file outside the folder its id names.
   - **Write safety** (playbook skill, steps 4–8): write steps have `mode: write` + plain-language `describe`;
     preconditions are read and `assert`ed before writes; `risk` matches impact (`high` → typed `confirm`, `critical`
     → `approval` with `excludes` for whoever it grants access); `idempotent: false` on writes whose repeat hurts (a
     restart retries steps in flight); compensation where possible and no promised undo `compensate` can't deliver;
     secrets only via `secretOutputs`; writes on reusable ids carry an `expected…` input from the row and an `assert`.
   - **Queries:** user data placed as `docs/content-recipes.md` › Quoting user data shows (quoted literals, not
     `$replace` character stripping); advanced filters via `${ advanced }`; filtering at the source, transforms small.
     Resource Graph: the join limits in `CLAUDE.md` (non-negotiable 14) — also read each query for joins hidden in
     templates. Every Resource Graph / Log Analytics query starts with its `// af:` line.
   - **Scale:** lists of thousands page at the source with no per-row transform; a transform that sees many rows has
     a `tests/content/content-at-scale-*.scale.test.ts` under the real budget.
   - **Probes** (schedule skill, step 4): `group` is a nav section key (the section's row shows its status); `remedy`
     says what the check really looks at (compare it with the query or filter: an incidents check doesn't cover
     advisories) and what to do first; `link` opens a page with the same filter (params that exist) or a Microsoft
     admin centre; details rows start with the item's name and the value that broke the rule; no item names in the
     message; every KQL probe is in `CONFIG_CHECKS` (and `OPERATIONAL` if it runs on a faster sweep).
   - **Browser expressions:** no `env.` in widget, header or action templates (`when`, `href`, `text`, `hint`) —
     always empty there; configuration comes through a `source: static` datasource.
   - **Tables and KPIs:** `kind: status` only for values that are fine or not, categories are `kind: enum`; `rowKey`
     unique (composite key when grouped by several columns); KPI labels fit two lines (`docs/widgets.md` › kpi), no
     hint after a status pill.
   - **Declarations:** `requires.scopes` exact and minimal; `requires.licences` present where a licence is needed;
     schedules use the automation identity and application permissions; write schedules need approval.
   - **Tenant data:** no ids/domains/UPNs/SKU literals — `${env.X}` with keys in `config/example.env`.
   - **Mock mode:** every datasource and KQL probe has a synthetic fixture (specific `af:` variants before generic
     ones; rows match what the query projects); nav/icon set; `version` bumped on every change.
   - **Lifecycle** (`docs/content-recipes.md` › Versions, previews and retiring): content checked only against
     fixtures says `preview: true`; retired content is `status: retired` + version bump (never deleted) with a
     `Retired — …` summary, nothing active links to, embeds, runs or schedules it, a retired schedule is also
     `enabled: false`, nothing active reads the Defender portal, and `docs/backlog.md` says how to bring it back.
4. Report findings ranked by severity (blocking / should fix / nit). Do not edit files.
