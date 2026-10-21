# ADR-003: Default-deny outbound request policy

Status: accepted (2026-10-15)

> Context, options and consequences back-filled on 2026-10-21 from the master plan it came from
> (`docs/plans/2026-10-15-adminforge-master-plan.md` §3, §5.4, task 1.12). The decision is unchanged.

## Context

ARM, Exchange, and some APIs have coarse scopes. ARM's `user_impersonation`, Exchange's `Exchange.Manage` and the
Teams admin API's `user_impersonation` can't express "read only", so even a Read-app token for them can change things
the engineer's own role allows. Microsoft Graph's read scopes are fine-grained, but several reads are POSTs (`$batch`,
Resource Graph and Log Analytics queries), so "GET only" doesn't separate reads from writes either.

## Options considered

- **Trust Microsoft's authorization (RBAC) alone.** Rejected: an engineer with Contributor or Exchange admin rights
  could change the tenant from a page meant to read it, and a bug in content could too.
- **Allow by HTTP method** (GET and HEAD only in read mode). Rejected: blocks the read-only POSTs AdminForge needs and
  says nothing about which writes are intended.
- **A generic write proxy for armed sessions.** Rejected: any request an engineer — or a script in their browser —
  could build would leave AdminForge with their write access.
- **Default-deny in the API**: in read mode only allow-listed read operations, in write mode only what published
  content declares. Chosen.

## Decision

In read mode only allowlisted operations leave the API; in write mode only operations declared by published content.

## Consequences

- Free-form write proxying is impossible by design. Every write is a `mode: write` step of a published, reviewed
  definition, with `describe`, `risk` and `confirm` or `approval`; the executor marks such calls `declaredWrite`, and
  nothing else may write.
- The policy lives in `portal/packages/connectors/src/policy.ts`: GET and HEAD, plus read-only POSTs anchored by path
  (`$batch` sub-requests are checked one by one). A Microsoft API AdminForge doesn't call yet is a reviewed connector
  and policy change (the `adding-a-service-connector` skill); connections to your own APIs refuse Microsoft audiences.
- PowerShell gets the same rule in two layers: read-mode jobs may run only `Get-*` commands, checked statically and
  enforced while the script runs (`SECURITY.md` › PowerShell runner).
- A new kind of read that needs a POST is a code change with a test, never a content setting.
