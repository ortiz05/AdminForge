# ADR-015: Synthetic transactions are built-in probes that write only to configured test objects

Status: accepted (2026-10-17)

## Context

Synthetic monitoring read Microsoft's APIs and public endpoints: it could say Exchange Online answers, not that mail
flows; that SharePoint's front door is up, not that a file uploads and downloads; that Teams' service health is green,
not that a meeting can be created. Engineers asked for tests that do what a person does. Each one changes something
(a message sent, a file uploaded, a meeting created), every 15 minutes, unattended. AdminForge's rules say writes are
declared by published content and scheduled writes need two-person approval (SECURITY.md › Unattended work). Options
considered: a playbook schedule per test (approval, run history and audit events every 15 minutes for fixed,
harmless operations — rejected as noise that would bury real approvals); a generic "transaction" probe whose steps
content defines (a generic write path through probes — rejected, ADR-003); and the PowerShell runner (it can't run as
the automation identity yet, and Graph covers all three).

## Decision

Three **built-in** probe check kinds — `mailFlow`, `fileRoundTrip`, `onlineMeeting` (`portal/apps/api/src/probes/
transactions.ts`) — each with fixed calls: send a test message and read it back, upload a JSON file and download it,
create an online meeting. Each removes what it made in the same run (and stale leftovers of earlier runs it
recognises by its own marker and their age). Content chooses only the kind, the waits and the **test objects**, and
those must be `${ env.AF_SYNTHETIC_… }` keys (a mail check may also send from `AF_MAIL_SENDER`): configuration an
administrator sets, never an address or id in git, and never another configured list (recipients, approvers). The
check is made by validation and again at run time, which reads the key straight from configuration. An unset key
means "not configured" and no call; a probe job whose probes are all waiting for configuration succeeds with a note.

Every changing call is a **declared write** in write mode, so the request policy, the emergency stop and the
protected-object guard apply (mailboxes are resolved to their object id first, so the guard recognises a protected
account); reads stay in the identity's read mode. They run only as an app identity (never a person's grant). They
need no two-person approval: they can't be pointed at anything but the configured test objects, the operations can't
be changed by content, and the permissions are scoped to those objects — Exchange RBAC for Applications on the test
mailboxes, Sites.Selected with a write grant on one site, a Teams application access policy for one user. A run in
which a transaction acted is audited as a write (`schedule.run`, `mode: write`, each transaction's outcome code), and
so is each transaction a scheduler one-shot (`--probe`, `--once`) ran that acted (`probe.run`). **Run now** and a
`--schedule` one-shot are refused while their schedule is turned off (an administrator who switched it off — say,
because a test object turned out to be in use — means it). One-shots follow the emergency stop like the scheduler:
none runs a transaction while automation is paused, and without the database (`--no-store`) they make no change,
since they could neither read the stop nor keep an audit record.

## Consequences

- Monitoring can tell "mail is slow / landing in junk / not arriving", "SharePoint uploads but downloads fail" and
  "Teams can't create meetings" apart from "the API is down".
- An administrator must create the test objects and scope the permissions (docs/operations.md › Synthetic
  transactions); until then the probes report "not configured" and do nothing.
- `Sites.Selected` (and its list and file siblings) no longer needs `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS`: it
  reaches nothing until a site is granted (grant `write`, never `fullcontrol`, which could manage the site's
  permissions). `OnlineMeetings.ReadWrite.All` still does, and that opt-in lifts the ceiling for every write
  permission content declares for the identity; there is no per-permission opt-in yet (docs/backlog.md). Where that
  matters, run the transactions sweep as a dedicated named identity (ADR-014) that holds nothing else.
- `Presence.Read.All` (everyone's real-time presence) counts as a sensitive read; the presence probe was dropped.
- A new transaction kind is a code change reviewed like this one (security review), never content.
