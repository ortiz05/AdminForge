# ADR-002: Separate Read and Write app registrations

Status: accepted (2026-10-15)

> Context, options and consequences back-filled on 2026-10-21 from the master plan it came from
> (`docs/plans/2026-10-15-adminforge-master-plan.md` §3, §5.1, §5.2, §5.4, §5.6). The decision is unchanged.

## Context

AdminForge must be read-only by default and write only on purpose. An Entra access token carries every scope consented
for its resource, not only the ones requested, so once an app holds write scopes every token it mints can write —
there is no genuinely read-only token from that app. Conditional Access can only target an app (or an authentication
context), and "assignment required" can only limit who may sign in to an app as a whole.

### Options considered

- **One app with incremental consent** (request write scopes only when needed). Rejected: after the first consent the
  write scopes ride in every token; a read page's token could change the tenant.
- **One app, with read-only enforced only by AdminForge's request policy.** Rejected as the only control: a bug in the
  policy becomes a tenant-wide write. The policy stays as a second layer (ADR-003).
- **Two delegated apps, Read and Write.** Chosen: the boundary is in the token itself, the Write app can require
  assignment (Operators only) and its own, stronger Conditional Access.

## Decision

Two delegated apps; write requires a step-up sign-in to the Write app (assignment required).

## Consequences

- Two consent sets to manage, both created and kept in step by `adminforge provision entra`;
  `adminforge validate --scopes` compares the scopes content declares with what each app holds. Privileged write
  scopes need an explicit installation opt-in (`AF_ALLOW_PRIVILEGED_WRITE_SCOPES`).
- Read sessions never hold a Write-app token. Arming is a fresh interactive sign-in to the Write app (`prompt=login`,
  proven by `auth_time`), plus a Conditional Access authentication context when `WRITE_AUTH_CONTEXT` is set (Entra ID
  P1); it is time-boxed (`WRITE_SESSION_MAX_MINUTES`) and audited, and shown in ember everywhere.
- Runs pause at a write step when the person isn't armed (`awaiting_arm`, ADR-010).
- Separate Conditional Access targeting: the Write app can demand phishing-resistant MFA on every sign-in without
  burdening everyday reading. `SECURITY.md` › Write access describes the model as built.
