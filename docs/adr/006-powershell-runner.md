# ADR-006: PowerShell runner with single-use workers

Status: accepted (2026-10-15)

> Context, options and consequences back-filled on 2026-10-21 from the master plan it came from
> (`docs/plans/2026-10-15-adminforge-master-plan.md` §3, §4.2, §4.3 "Runner step", phase 6). The decision is
> unchanged; where it ran changed with ADR-008 and ADR-017.

## Context

Exchange/Teams/SharePoint admin is PowerShell-first. Microsoft Graph doesn't cover mailbox permissions, forwarding,
distribution lists, Teams policies or SharePoint tenant settings; the Exchange Online, Teams and PnP modules do. They
must run with the calling engineer's delegated tokens (Read or Write app, by mode), one person's tokens must never
reach another person's job, and module imports take seconds.

### Options considered

- **Azure Functions with PowerShell.** Rejected: a 230-second HTTP response limit, cold module loads on every
  scale-out, and tokens would have to sit in queue messages.
- **On-behalf-of flows with extra app registrations per service.** Rejected: more apps and consents to manage, and the
  read/write split (ADR-002) would have to be rebuilt for each.
- **Long-lived PowerShell sessions shared between jobs.** Rejected: one engineer's connection and tokens could serve
  another's job.
- **A Node supervisor with pre-forked, single-use `pwsh` workers**, tokens handed to each job over stdin. Chosen:
  isolation per job, module import time hidden by pre-forking, no HTTP time limit, tokens never in a queue.

## Decision

Node supervisor + pre-forked single-use pwsh workers; tokens passed over stdin per job.

## Consequences

- Isolation between users; no long-lived sessions. A worker runs one job and exits.
- Scripts are content (`portal/content/scripts`), pinned by SHA-256 in the definition that runs them; inputs arrive as
  JSON on stdin and are never interpolated into script text. Modules are pinned (`modules.lock.json`) and installed
  into the image.
- The plan's "Runner API" app registration and Container App never existed: the API signs every job with HMAC over a
  key derived from `RUNNER_SHARED_KEY`, seals the tokens, and verifies every event of the answer; the runner listens
  on loopback, as the pod's sidecar since ADR-017.
- Read-mode jobs are kept to reads by a static policy and runtime guards (ADR-003); write jobs run only for an armed
  engineer and pass the emergency stop and protected-object checks first. Accepted risk: a write-mode script can read
  the runner's shared key, since the workers and the supervisor share one uid and the restricted pod can't split them
  (S-39 of the 2026-10-21 security review).
- Scheduled (automation identity) script jobs aren't supported yet: the runner can't sign in to Exchange, Teams or
  SharePoint as an application (`script_not_supported`, `docs/backlog.md`). `portal/apps/runner/README.md` describes
  the runner as built.
