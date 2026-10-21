# Checklists

Copy what you need into your PR or your notes. Each item links to where it's explained.

## Your first day

- [ ] Repository access, and you're in the team channel
- [ ] Node 24, pnpm via `corepack enable`, Google Chrome, VS Code + YAML extension, Claude Code
      ([setup](01-setup.md))
- [ ] `pnpm install`; `git config core.hooksPath` prints `.githooks`; optional commit template configured
- [ ] Mock mode runs at <http://localhost:5173>; you switched roles and armed write access with the dev toolbar
- [ ] `pnpm guard`, `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:e2e` pass on `main`
- [ ] Read [How AdminForge works](02-how-adminforge-works.md) and [Security for contributors](04-security.md)

## Your first week

- [ ] Your env file exists and `init:local` filled it (your own `DATABASE_PATH`, token-cache key); `env check` runs
      ([setup](01-setup.md#give-yourself-a-local-database))
- [ ] Read guides 3–13 and `CLAUDE.md`; skimmed `SECURITY.md`, `docs/architecture.md`, `docs/api.md` → Conventions
- [ ] Traced one request end to end in the code: a page's datasource, from `/api/datasources/execute-many` to
      the outbound executor and back
- [ ] Made a small content change in mock mode with Claude Code and the matching skill (e.g. a column on a report),
      with fixture, version bump, `validate` and `test`
- [ ] Opened your first PR with a conventional title and the template filled in; had it reviewed and squash-merged
- [ ] Reviewed someone else's PR with the reviewer checklist below
- [ ] (When granted) validation-tenant access works: `pnpm adminforge env check`,
      `pnpm adminforge provision status`, one read-only live check

## Opening a pull request

- [ ] One topic; small enough to review in one sitting; rebased on `main`
- [ ] Title is a commit header (`<type>(<scope>): <summary>`); template filled in
- [ ] Ships complete: code/content + tests + fixtures + docs + changelog ([documentation
      matrix](11-documentation.md#what-to-update-for-each-kind-of-change))
- [ ] `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm guard`, and the vitest projects you touched pass
- [ ] Content: `pnpm adminforge validate` and `pnpm adminforge test` clean; versions bumped
- [ ] Probes: `group`, `remedy`, `link`, detail rows that name the item; swept by tag
- [ ] New queries checked live (read-only), or listed as fixture-only in `docs/licensing-review.md` and
      `docs/backlog.md`
- [ ] Big lists paged at the source; a `content-at-scale-*` case for any transform over them
- [ ] Web dependency or bundling changed: `pnpm build && pnpm test:e2e:prod` (in a checkout no service serves)
- [ ] UI: screenshots in steel + daylight reviewed; keyboard and axe checked
- [ ] API: contract in `@adminforge/schemas`; role checks; audit per state change; `docs/api.md`
- [ ] Reviewer agents run where they apply (content, security, design) and findings handled
- [ ] Nothing tenant-specific or secret anywhere — code, fixtures, docs, screenshots, messages, description
- [ ] Risk and rollout filled in: migration, config keys, permissions, publish/restart, how to undo

## A new section, or retiring one

- [ ] `navigation.yaml` section (key, label, icon, order); pages and overview dashboard under `nav.section: <key>`
- [ ] Reports in the catalogue area `<key>`; a "… reports" item when the section is mostly reports
- [ ] Checks: probes with `group: <key>`, a "Service checks" item (`/monitoring?group=<key>`), `probeStatus` with
      `group: <key>` on the overview
- [ ] Screenshots of the overview and a list in steel and daylight — KPI labels fit, no alert banners
- [ ] Retiring: `status: retired` + version bump on every related definition (schedules also `enabled: false`); no
      active links left (`tests/content/retired-content.test.ts`); `publish --dry-run` shows `− retire`; backlog says
      how to bring it back

## Reviewing a pull request

**Fit**

- [ ] Is this the right place for it? Content before code; generic engine/renderer changes, not one-off special cases
- [ ] Reuses what exists; names and structure match the surrounding code ([repository map](03-repository-map.md#naming))
- [ ] The title and commits follow the convention; the description explains why

**Correctness**

- [ ] Does what the description says; edge cases, empty and error states handled
- [ ] Tests would fail without the change; refusals and roles covered; no fixed-date/real-clock mixes, no sleeps
- [ ] Concurrency: conditional updates, transactions where invariants span statements

**Security** (see the next list for sensitive changes)

- [ ] No tenant data or secrets; inputs parsed with zod; untrusted values quoted with the helpers
- [ ] Probe messages carry no names or rows (those are Operator-only details); links are in-app or https
- [ ] Roles checked server-side; ids compared by oid; content `requires.portalRoles` honoured
- [ ] Microsoft calls only through the outbound executor; writes only from declared content
- [ ] Every state change audited; errors have message + hint and leak nothing

**Docs and operations**

- [ ] The docs in the matrix are updated; changelog entry reads well for users
- [ ] Rollout is safe: additive migration, safe defaults, permissions called out

## Security review

For changes on the [security-review list](04-security.md#what-needs-a-security-review), in addition to the above:

- [ ] `security-reviewer` agent run on the diff; every finding fixed or explicitly accepted in the PR
- [ ] Tokens never reach the browser, logs, errors, audit or stored rows
- [ ] Read mode stays default-deny; new read-only POSTs are anchored, truly read-only and tested
- [ ] Nothing new can act as the automation identity from an interactive path
- [ ] Separation of duties intact: no self-approval, no self-grant, AdminForge's own apps/groups/protected accounts
      out of reach
- [ ] Anything that sends data out (email, Teams, files, webhooks, new hosts) uses configured destinations only and
      treats text as plain text
- [ ] Anything that loosens a playbook (risk, confirmation, approval, scopes, connections, hosts) is called out
- [ ] Writes on reusable ids assert the target still matches what the person saw; high-risk bulk uses a typed
      confirmation
- [ ] Nothing in the browser needs `eval` or inline script; the CSP is unchanged
- [ ] `SECURITY.md` updated (section, threats row or known gap)
- [ ] A code owner approved (or, for a code owner's own change, another engineer — see [guide
      10](10-git-and-pull-requests.md#reviewing))

## Definition of done

A change is done when it is merged **and**:

- [ ] Content: published by a code owner, visible in the portal, and checked once live (read-only) if it added a query
- [ ] Code: released and deployed by a code owner, with the rollout notes followed
- [ ] The backlog has entries for anything deliberately left out
- [ ] Anything you learned that would have saved you time is in this guide
