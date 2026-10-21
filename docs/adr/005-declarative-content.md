# ADR-005: Declarative content with JSONata expressions

Status: accepted (2026-10-15)

> Context, options and consequences back-filled on 2026-10-21 from the master plan it came from
> (`docs/plans/2026-10-15-adminforge-master-plan.md` §2 principle 4, §3, §7). The decision is unchanged.

## Context

Engineers should add pages, reports, and playbooks without releases. The people who know what a page or a change
should do are systems engineers, not front-end developers, and a portal for the whole estate needs hundreds of pages,
reports, playbooks and checks that look and behave the same. Each needs review — many change the tenant — and
expressions in them see tenant data, so they must not be able to run arbitrary code.

## Options considered

- **Code-only pages** (a React screen per page). Rejected: every page is a release, the look drifts page by page and
  reviewers must read UI code to see what a page calls.
- **Arbitrary JavaScript in definitions.** Rejected: unbounded and unsafe — a definition could do anything the browser
  or the server can, and the browser's security policy forbids `eval` (`script-src 'self'`).
- **YAML validated by schemas, with a side-effect-free expression language.** Chosen: reviewable diffs, editor
  autocomplete from generated JSON Schemas, and JSONata expressions that can only compute.

## Decision

YAML validated by zod (JSON Schema for editors); JSONata for expressions; coded pages as escape hatch.

## Consequences

- Reviewable diffs and hot reload in development; in production, reviewed content reaches the database only through
  `adminforge publish`, every definition is versioned and a run pins the version and SHA-256 it started with.
- The renderer and engine are extended generically, never for one page (CLAUDE.md rule 3); a new widget option or
  step type is a schema change documented in `docs/widgets.md` or the schema.
- Expressions get their own safety net: helpers that encode untrusted values (`$odata()`, `$kql()`, `$encode()`,
  `$guid()`), an injection lint in `adminforge validate`, time and size limits, and a 250 ms budget for transforms.
- Content is retired, not deleted (`status: retired` plus a version bump), because saved views, schedules and audit
  records refer to ids.
- Coded screens remain for what content can't express well (the overview, Query Studio, schedules, monitoring).
  `docs/onboarding/08-content-guide.md` and the skills describe the content kinds as built.
