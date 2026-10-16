<!--
Title: a Conventional Commits header — it becomes the squash commit on main (CI checks it).
  e.g. "feat(reports): schedule a report from the catalogue"   ·   docs/onboarding/10-git-and-pull-requests.md
-->

## What and why

<!-- What changes for the person using AdminForge (or for the next engineer), and why now. Link the issue/backlog item. -->

## How it was checked

<!-- Commands you ran and what they showed; screenshots (steel + daylight) for UI changes; live validation, if any,
     described as counts and statuses only — no tenant names, ids or UPNs. -->

## Checklist

- [ ] Content, code, tests, fixtures and docs ship together (`docs/onboarding/11-documentation.md` says which docs)
- [ ] `pnpm guard`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and the vitest project(s) I touched pass
- [ ] Content changes: `pnpm adminforge validate` and `pnpm adminforge test` are clean; changed definitions bumped
      their `version`
- [ ] UI changes: screenshots in steel and daylight, design tokens only, keyboard and screen-reader checked
- [ ] API changes: contract in `portal/packages/schemas`, role checks, audit for state changes, `docs/api.md` updated;
      new error codes in `docs/troubleshooting.md`
- [ ] Security-relevant (anything on the list in `docs/onboarding/04-security.md` → What needs a security review):
      `security-reviewer` run and findings addressed or listed below
- [ ] Nothing tenant-specific, no secrets, no real names, UPNs or ids — in code, fixtures, docs, screenshots or this
      description
- [ ] `CHANGELOG.md` (Unreleased) updated for anything a user or operator would notice
- [ ] New licence or permission needs recorded (`docs/licensing-review.md`, `docs/access.md`)

## Risk and rollout

<!-- Migration? New configuration key? Needs `adminforge publish`, a restart, or a provisioning run? Anything an
     operator must do, and how to undo it. Write "None" if there is nothing. -->

## Open questions / follow-ups

<!-- Anything deliberately left out (and recorded in docs/backlog.md). -->
