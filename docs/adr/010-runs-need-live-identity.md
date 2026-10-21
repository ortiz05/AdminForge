# ADR-010: Interactive runs use the engineer's identity

Status: accepted (2026-10-15)

> Context, options and consequences back-filled on 2026-10-21 from the master plan it came from
> (`docs/plans/2026-10-15-adminforge-master-plan.md` §2, §3, §5.6, §7.8). The decision is unchanged.

## Context

Delegated access must stay honest. A playbook run outlives the request that started it: steps wait for an approval,
for input, for write access, or simply run in the background. AdminForge's principle is that it can never do more
than the engineer could do themselves, and that a second person's approval means a second person acts.

### Options considered

- **Stored service-account refresh tokens** (one account runs every background step). Rejected: app-only access by
  another name — every run could do what that account can, whoever started it.
- **The API's own application identity for background steps.** Rejected for the same reason; unattended work is a
  separate, explicit decision (ADR-011).
- **Each run uses the live session of the person it acts for**: the initiator's token cache for their steps, the
  approver's for the steps after an approval. Chosen.

## Decision

Playbook runs use the initiator's session; post-approval steps run as the approver.

## Consequences

- Logout/disarm pauses runs: a run waits (`awaiting_arm`, `awaiting_reauth`) at the next step that needs a write token
  or a new sign-in, and stops after 24 hours if nobody returns. An approver must be armed when the steps after the
  approval write as them.
- Every step records who acted and in which mode. Resuming re-checks the person's roles and the definition's version.
- A run can't be handed to someone else — that would change who acts (the plan's runbook "Assign to…" was declined,
  `docs/decisions.md`); start a new run instead.
- Unattended work needs its own identity: ADR-011 (the automation identity) and ADR-014 (a named app registration or
  the schedule's creator) amend this ADR for schedules only. `SECURITY.md` › Write access describes runs as built.
