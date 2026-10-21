# ADR-014: A schedule runs as the automation identity, a named app registration, or its creator

Status: accepted (2026-10-17)

## Context

ADR-011 gives every schedule one app-only automation identity. Engineers asked to choose the account a schedule runs
as: another app registration (a team's own, with only the permissions that team's schedules need) or a user account.
A single app-only identity is the union of everything every schedule needs; a user's own access is often the smaller,
more honest scope for a report that person reads every Monday. Alternatives considered: a shared "service account"
user with a stored password (a password in a file, MFA impossible, no Conditional Access story — rejected), storing the
Write app's refresh token (would bypass arming, step-up and its time box — rejected), and per-schedule client secrets
held in the database (secrets beside the data they unlock — rejected).

## Decision

`identity` on a schedule is one of:

- `automation` (default) — ADR-011, unchanged.
- `{ app: <name> }` — a named app-only identity: its own app registration, certificate (preferred) or secret in the
  host's env file, permission ceilings and protected ids, provisioned by `adminforge provision entra` like the
  automation identity. Content and portal schedules may name it; changing the identity of a write-capable schedule
  re-requires two-person approval.
- `{ user: creator }` — the schedule runs with its creator's delegated access through the Read app only, so delegated
  schedules are read-only (reports, probes); write playbooks and scripts are refused. The creator consents once per
  schedule; the refresh token is sealed in that schedule's own token-cache partition (AES-256-GCM, key id recorded),
  kept while the schedule exists and deleted when it is deleted, disabled for good, or its creator loses access.
  Before each run the creator's roles are re-read (as at sign-in) and the existing creator check runs. A claims
  challenge, a revoked or expired grant (password reset, "revoke sessions", 90 days unused) or a Conditional Access
  sign-in-frequency policy puts the schedule in "needs sign-in" — nothing runs until the creator signs in for it again
  — and the owner is told. Only the creator can renew it; a Portal Admin can disable or delete it.

Every run and audit event records who it executed as ("scheduled by X, executed as Y").

## Consequences

Amends ADR-001 (tokens outlive a session only for a user schedule, sealed per schedule) and ADR-011. A stolen database
plus `TOKEN_CACHE_KEY` now also yields read-only refresh tokens of people with user schedules — the key id makes
rotation possible and SECURITY.md lists the trade-off. Tenants with sign-in frequency or token protection policies
will see user schedules ask for sign-in regularly; that is by design. See SECURITY.md and docs/access.md.

As built (2026-10-17): `{ user: creator }` is offered only for report schedules created in the portal (content
schedules have no creator to consent), and its jobs are reports (probes are allowed by the schema for a future
portal probe form). "Disabled for good" means deleted, switched to another identity, or the creator lost access — a
plain disable keeps the grant so turning it back on needs no new sign-in. Runner (PowerShell) jobs can't be scheduled
yet: the runner can't sign in to Exchange, Teams or SharePoint as the automation identity, so a schedule's `script` job
fails with `script_not_supported` (`schedules/jobs.ts`; docs/backlog.md › "PowerShell steps for scheduled (automation)
runs"). `news` and `contentHealth` jobs always run as the automation identity.
