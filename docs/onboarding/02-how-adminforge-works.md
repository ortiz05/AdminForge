# 2. How AdminForge works

The mental model you need before changing anything. The deployed details (units, ports, tables) are in
[`docs/architecture.md`](../architecture.md); the reasons are in [`docs/adr/`](../adr/).

## Four ideas everything rests on

1. **The browser never holds a Microsoft token.** The API is a backend-for-frontend (BFF): the browser has an
   HttpOnly session cookie, the API holds the tokens and makes every Microsoft call (ADR-001).
2. **People act as themselves.** Interactive work uses the engineer's own **delegated** permissions, so AdminForge can
   never do more than that person could do in the Microsoft admin centers. It only adds restrictions (ADR-002).
3. **Reading is the default; writing is an event.** Read mode is default-deny for anything that isn't a read
   (ADR-003). Writing needs "armed" write access — a second, step-up sign-in to a separate Write app, time-boxed — and
   happens only through steps declared in published content.
4. **Features are content.** Pages, dashboards, reports, playbooks, runbooks, schedules, probes and connections are
   YAML in `portal/content`, validated by schemas, reviewed in git, published to Postgres, and rendered or executed by
   a generic engine (ADR-005). Code changes are for capabilities the content can't express.

## The moving parts

```mermaid
flowchart LR
  browser(["Browser: React SPA"]) -->|cookie + CSRF header| api["API / BFF (Fastify)"]
  api --> db[("Postgres")]
  api -->|delegated tokens| ms["Microsoft Graph, ARM,<br/>Resource Graph, Log Analytics"]
  api -->|enqueue runs| worker["Run worker"]
  worker -->|initiator's tokens or automation identity| ms
  scheduler["Scheduler"] -->|automation identity| ms
  api & worker -->|signed jobs + sealed tokens| runner["PowerShell runner"]
  runner --> ps["Exchange, Teams, SharePoint"]
  worker & scheduler --> db
  cli(["adminforge CLI"]) -->|publish content| db
```

| Part      | Code                            | Job                                                                                          |
| --------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| Web app   | `portal/apps/web`               | The SPA: shell, content renderer (`/p/$key`), playbook drawer, runs, schedules, reports      |
| API / BFF | `portal/apps/api`               | Sign-in, sessions, request policy, datasources, runs, schedules API, audit, SSE, downloads   |
| Worker    | `portal/apps/api` (`worker.ts`) | Executes playbook and runbook steps from the queue                                           |
| Scheduler | `portal/apps/scheduler`         | Unattended jobs as the automation identity: probes, reports, scheduled playbooks, news feeds |
| Runner    | `portal/apps/runner`            | Pinned PowerShell scripts in single-use workers, with forwarded delegated tokens             |
| CLI       | `portal/tools/cli`              | `adminforge` — env check, provisioning, scaffolding, validate, test, publish                 |

## The three identities

| Identity       | Kind        | Used for                                   | Rule of thumb                                                                      |
| -------------- | ----------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| **Read** app   | Delegated   | Everything an engineer looks at            | Every portal user; the request policy keeps it read-only                           |
| **Write** app  | Delegated   | Changes, only while armed (Operators only) | Step-up sign-in, time-boxed; only for `mode: write` steps in published content     |
| **Automation** | Application | Schedules on the host                      | Read-only by default; never on interactive paths; scheduled writes need two people |

Portal roles (`Portal.Reader`, `Portal.Operator`, `Playbook.Approver`, `Playbook.Author`, `Portal.Admin`) are app roles
on the Read app, granted through security groups and re-checked with Entra every 5 minutes
([`docs/access.md`](../access.md)).

## What happens when…

**…an engineer opens a page.** The SPA asks the API for the page’s data (`POST /api/datasources/execute-many`,
one round trip for all of them). The API loads the published definition, checks `requires.portalRoles` and
licences, builds each datasource request from content with safely quoted parameters, sends it through the
**outbound executor** (request policy → delegated Read token → Microsoft), applies the definition's
`transform`, and returns rows. Tokens, raw upstream errors and other people's data never reach the browser.

**…an engineer changes something.** They arm write access (step-up sign-in to the Write app), open a playbook, see a
**dry-run preview** of exactly what will change, confirm, and the API enqueues a run. The worker executes the steps
with the engineer's own tokens; risky playbooks need typed confirmation or a second person's **approval**. Everything
is audited with the person, the identity and Microsoft's request id. AdminForge's own apps, role groups and
protected accounts are refused centrally, and an administrator can pause all changes with the **emergency stop**.

**…a schedule fires.** The scheduler (one leader at a time) runs it as the automation identity: a probe sweep, a
report export (file, email, Teams), a content-health check, a news collection, or a playbook handed to the worker.
Report schedules can also be created in the portal by Operators; anything that writes needs a second person's
approval before it is enabled. Probe results feed **Synthetic monitoring**, grouped by service; a check's detail says
what it found (the rows, for Operators), what to do and where to act.

**…content changes.** An engineer edits YAML, `adminforge validate` and `adminforge test` check it, a pull request is
reviewed and merged, and `adminforge publish` writes the new versions to Postgres. Running services pick it up through
`NOTIFY` — no redeploy. In local development the API reads the files directly with hot reload.

## Where state lives

Postgres is the only stateful dependency (ADR-004): sessions and the sealed token cache, published definitions, runs
and approvals, schedules and their history, probe results, news, the hash-chained append-only audit log, preferences
and settings. Outside it: the env files, report files, the automation certificate. Nothing about a tenant lives in the
repository.

## Read next

[Repository map](03-repository-map.md) — where each of these parts lives and where your change goes.
