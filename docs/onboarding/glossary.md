# Glossary

| Term                            | Meaning                                                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AdminForge**                  | This portal: admin work on Entra ID, Microsoft 365, Intune, Defender and Azure through delegated access                                                               |
| **Approval**                    | A second person's decision a run or a write-capable schedule waits for; never the requester or someone the change benefits                                            |
| **Area**                        | The part of the estate a definition belongs to — `identity`, `m365`, `endpoint`, `security`, `azure` — and its content folder                                         |
| **Armed / write access**        | A time-boxed window, after a step-up sign-in to the Write app, in which an Operator's playbooks may change data. Shown in ember                                       |
| **Audit log**                   | Append-only, hash-chained record of every state change (`audit_events`); `pnpm adminforge audit verify` checks it                                                     |
| **Automation identity**         | The application identity schedules run as on the host; read-only by default, never used interactively                                                                 |
| **BFF**                         | Backend-for-frontend: the API holds sessions and tokens so the browser never sees a Microsoft token                                                                   |
| **Catalogue (Reports)**         | `/reports`: every report with filters, details and in-portal scheduling                                                                                               |
| **Code owner**                  | A reviewer named in `.github/CODEOWNERS` for sensitive paths; by team agreement also the people who publish, upgrade and provision                                    |
| **Content / definition**        | A YAML file in `portal/content` (page, report, playbook, schedule, …), validated by `@adminforge/schemas` and published to Postgres                                   |
| **Correlation id / reference**  | The id on every response, error and audit event; what people read out when something fails                                                                            |
| **CSRF header**                 | `X-AdminForge-CSRF`, required on every non-GET `/api` call (and the state-changing `/auth` POSTs)                                                                     |
| **Datasource**                  | A content-declared request (Graph, ARM, Resource Graph, Log Analytics, runner, …) plus an optional `transform`                                                        |
| **Delegated**                   | Acting as the signed-in person with their own permissions (the Read and Write apps)                                                                                   |
| **Dry run / preview**           | A playbook's simulated run showing exactly what would change, before confirming                                                                                       |
| **Emergency stop**              | Admin → Settings switch that pauses all changes and/or all automation, audited                                                                                        |
| **Fixture**                     | Synthetic Microsoft response used in mock mode and tests (`tests/fixtures/`); `Example Org`, `example.com`                                                            |
| **Guards**                      | Tests that block secrets, your tenant's values and raw colours in committable text files; run by the pre-commit hook (tenant values are checked only there) and in CI |
| **Licence gate**                | `requires.licences`: the UI explains "Requires …" instead of failing when the tenant lacks a licence                                                                  |
| **Mock mode**                   | `AUTH_MODE=mock DATA_MODE=fixtures`: AdminForge with a fake sign-in, fixtures and in-memory state                                                                     |
| **Outbound executor**           | The only path to Microsoft (`ctx.outbound`): request policy, tokens, provenance, limits, error mapping                                                                |
| **Playbook / runbook**          | A declared change (inputs → preview → confirm → steps) / a guided procedure of playbooks and manual steps                                                             |
| **Portal roles**                | `Portal.Reader`, `Portal.Operator`, `Playbook.Approver`, `Playbook.Author`, `Portal.Admin` — app roles granted through groups                                         |
| **Portal schedule**             | A report schedule an Operator created in the portal (stored in the database, id `portal.*`) rather than in content                                                    |
| **Probe**                       | A synthetic or KQL configuration check run by a schedule, results in `probe_results`                                                                                  |
| **Protected objects**           | AdminForge's own apps, the principals holding its roles and listed accounts — writes naming them are refused                                                          |
| **Publish**                     | `adminforge publish`: reviewed content from `origin/main` → Postgres, picked up by running services                                                                   |
| **Read app / Write app**        | The two delegated app registrations: everyday reading; changes while armed                                                                                            |
| **Request policy**              | Default-deny rules on outbound calls: only reads in read mode, declared writes when armed                                                                             |
| **Runner**                      | The PowerShell service for Exchange, Teams and SharePoint: pinned scripts, sealed tokens, signed jobs                                                                 |
| **Skill**                       | A Claude Code recipe for one extension point (`.claude/skills/`)                                                                                                      |
| **Steel / daylight / contrast** | The themes; screenshots are reviewed in steel and daylight                                                                                                            |
| **Step-up**                     | The fresh sign-in (and authentication context, when configured) needed to arm write access                                                                            |
| **Validation tenant**           | The non-production tenant used for live tests; writes only on `AF-Test-*` objects                                                                                     |
