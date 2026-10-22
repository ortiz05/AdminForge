# Licensing and permission review

What each AdminForge feature needs from the tenant — licence, Microsoft permission, role — and how far it has been
checked live. AdminForge builds features the validation tenant can't exercise yet: each one declares its licences
(`requires.licences`), shows a **"Requires …"** state in the UI when they are missing, and is listed here. No tenant
identifiers are recorded in this file or its findings.

This is the current map: it changes when a feature, or what Microsoft requires, changes. What a session checked — on
which day, against which tenant state, with Microsoft's sources — is a dated **finding** in `docs/licensing/findings/`,
one file each, listed under [Findings](#findings). A finding is a record of its day; a later one supersedes it.

**Recording something** (CLAUDE.md rules 9 and 14): update the feature's row in its area below, or add one; write what
you checked live, or couldn't, as a new finding `docs/licensing/findings/<yyyy-mm-dd>-<topic>.md` with a row under
Findings; put the live check still to do in `docs/backlog.md`. Keep the tables narrow and the detail in the finding:
`tests/unit/docs/registers.test.ts` keeps every line of this file under 300 characters and every finding linked from
it.

In the **Live** columns, "yes" means the request worked against a tenant at least once (its finding says when and how);
"fixtures only" means no request of it has reached Microsoft yet.

## At a glance

| Feature                                          | Requirement                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Users, groups, roles, apps, devices (directory)  | Entra ID Free                                                                               |
| Directory audit log                              | Entra ID Free (7 days; 30 days with P1)                                                     |
| Sign-in logs, sign-in activity                   | Entra ID P1                                                                                 |
| Conditional Access, authentication context       | Entra ID P1                                                                                 |
| PIM, Identity Protection                         | Entra ID P2                                                                                 |
| Exchange, Teams, SharePoint administration       | The workload's Microsoft 365 licence (the tenant's; the engineer needs only the admin role) |
| Teams settings and channels (Graph Teams APIs)   | A Microsoft Teams licence on the signed-in person (application permissions: none)           |
| Microsoft 365 usage reports                      | Any Microsoft 365 subscription; Microsoft starts the reports 24–48 h after the first one    |
| Intune                                           | Intune Plan 1                                                                               |
| Azure resources, Resource Graph, Monitor, Cost   | An Azure subscription and Azure RBAC (Cost Management: an offer that has it)                |
| Defender incidents, alerts, hunting, device data | Retired content (see [Microsoft Defender](#microsoft-defender-retired))                     |

## Licence features

Content declares licences by feature key in `requires.licences`; any SKU that contains one of the feature's service
plans enables it (`portal/apps/api/src/capabilities/features.ts`). When the tenant's licences can't be read, the feature
is offered and Microsoft decides.

| Key                  | Feature                                                | Service plans that enable it                                                       |
| -------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `conditionalAccess`  | Conditional Access                                     | `AAD_PREMIUM`, `AAD_PREMIUM_P2` (Entra ID P1)                                      |
| `signInLogs`         | Sign-in logs and sign-in activity                      | `AAD_PREMIUM`, `AAD_PREMIUM_P2` (Entra ID P1)                                      |
| `pim`                | Privileged Identity Management                         | `AAD_PREMIUM_P2` (Entra ID P2)                                                     |
| `identityProtection` | Identity Protection (risky users)                      | `AAD_PREMIUM_P2` (Entra ID P2)                                                     |
| `intune`             | Microsoft Intune                                       | `INTUNE_A`, `INTUNE_EDU`, `INTUNE_SMBIZ`                                           |
| `exchange`           | Exchange Online                                        | `EXCHANGE_S_STANDARD`, `EXCHANGE_S_ENTERPRISE`, `…_DESKLESS`, `…_ESSENTIALS`       |
| `sharepoint`         | SharePoint Online                                      | `SHAREPOINTSTANDARD`, `SHAREPOINTENTERPRISE`, `SHAREPOINT_S_DEVELOPER`             |
| `teams`              | Microsoft Teams                                        | `TEAMS1`, `TEAMS_AR_DOD`, `TEAMS_AR_GCCHIGH`                                       |
| `defender`           | Defender incidents, alerts, advanced hunting (retired) | `MTP`, `WINDEFATP`, `MDE_LITE`, `MDE_SMB`, `ATP_ENTERPRISE`, `THREAT_INTELLIGENCE` |
| `defenderEndpoint`   | Defender for Endpoint device data (retired)            | `WINDEFATP`, `TVM_PREMIUM_1`                                                       |

There is no key yet for Entra ID P1 as such or for the Microsoft 365 usage reports: P1-only content declares the
service plan `AAD_PREMIUM` (`docs/backlog.md`, API).

## Identity (Entra ID)

| Feature                                                                                    | Needs                                                                                                       | Live                                     |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Users, groups, roles, apps; assign or remove a role                                        | Entra ID Free; role writes: Write app `RoleManagement.ReadWrite.Directory` (approval for high and critical) | yes                                      |
| Directory audit log (high-impact changes, role groups)                                     | Free (7-day window, 30 with P1); `AuditLog.Read.All`; `$filter` takes `or` and `startswith`, not `in`       | yes                                      |
| Conditional Access policies, named locations, baseline                                     | `conditionalAccess`; `Policy.Read.All` (app-only: an empty list, no error, without P1)                      | yes                                      |
| Sign-ins, sign-in page, sign-in health probes                                              | `signInLogs`; `AuditLog.Read.All`; Reports Reader or Global Reader                                          | yes                                      |
| Users list, licence holders (`m365.licence`), inactive users and guests (`signInActivity`) | `signInLogs`                                                                                                | yes                                      |
| Authentication methods registration, users without MFA                                     | `signInLogs`; `AuditLog.Read.All` (`userRegistrationDetails`)                                               | requests yes; report not filled yet      |
| PIM: eligible roles, activation, privileged role report                                    | `pim`; `RoleManagement.Read.Directory`, `RoleEligibilitySchedule.Read.Directory`                            | yes (activation too)                     |
| Add or remove role eligibility                                                             | `pim`; `RoleEligibilitySchedule.ReadWrite.Directory`; Privileged Role Administrator; adding: approval       | preview only                             |
| Risky users (list, report, schedule)                                                       | `identityProtection`; `IdentityRiskyUser.Read.All`; schedules `IdentityRiskEvent.Read.All` (app)            | yes (no user at risk)                    |
| Confirm compromised, dismiss risk                                                          | `identityProtection`; `IdentityRiskyUser.ReadWrite.All`; Security Operator on the person                    | refused: tester has no Security Operator |
| App access: assign or remove                                                               | Free; assigning a group to an app needs P1                                                                  | user assignment yes                      |
| Revoke a consent grant (and any grant write)                                               | Free; the guard reads the grant: `DelegatedPermissionGrant.Read.All` or `Directory.Read.All`                | grant read not checked                   |
| Groups: security, Microsoft 365, dynamic; edit a rule                                      | Dynamic membership: Entra ID P1 (`AAD_PREMIUM`); Microsoft 365 groups need Exchange Online                  | security groups yes; dynamic preview     |
| Licence assignment errors, group lifecycle                                                 | Group-based licensing and group expiry: P1; `Group.Read.All`, `User.Read.All`, `Directory.Read.All`         | yes                                      |
| SAML certificates, subscriptions, licence seats, attributes                                | Free; `Application.Read.All`, `Organization.Read.All`, `User.Read.All`                                      | yes                                      |
| Unused applications, authentication method strength                                        | `signInLogs`; `AuditLog.Read.All` (`servicePrincipalSignInActivities` is Graph beta)                        | yes                                      |
| Conditional Access report-only impact                                                      | `conditionalAccess` + `signInLogs`; Log Analytics path: `Data.Read`, Log Analytics Reader on the workspace  | Graph path yes; KQL path not             |
| Application permissions (Exchange and SharePoint rows)                                     | The workloads' service principals, which exist once they are licensed                                       | Graph rows yes                           |

## Exchange Online

| Feature                                                  | Needs                                                                                              | Live                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------- |
| Runner connection                                        | Read and Write apps `Exchange.Manage`; an Exchange role on the person (a new one can take an hour) | yes                         |
| Mailboxes, shared mailboxes, mailbox page                | `exchange`; View-Only Recipients (Global Reader) or higher; `User.Read.All` for the sign-in state  | yes                         |
| Distribution lists, list page                            | `exchange`; `Group.Read.All`, `GroupMember.Read.All`                                               | yes                         |
| Forwarding page and report, inbox-rule audit             | `exchange`; `Get-InboxRule` needs Mail Recipients (Exchange Recipient Administrator)               | yes                         |
| List members; Full Access, Send As, Send on Behalf       | Write app `Exchange.Manage`; Exchange Recipient Administrator (or list owner); `User.Read.All`     | yes                         |
| Automatic replies, hide from address lists               | as above                                                                                           | yes                         |
| Forward a mailbox (with approval), clear forwarding      | as above; a second engineer with `Playbook.Approver` approves                                      | up to the approval gate     |
| Turn an inbox rule off or on, remove it                  | as above                                                                                           | lookup and refusals only    |
| Convert to shared mailbox                                | as above                                                                                           | refusal path only           |
| Create shared and room mailboxes and lists; remove them  | as above; sign-in changes: `User.EnableDisableAccount.All` and User Administrator                  | yes (create and re-run)     |
| Scheduled external forwarding and shared-mailbox sign-in | App-only Exchange in the runner (`Exchange.ManageAsApp`, a certificate, an Exchange role)          | not supported yet           |
| Mailbox storage and inactivity                           | `Reports.Read.All` (usage reports)                                                                 | not yet (see usage reports) |

## SharePoint and OneDrive

| Feature                                    | Needs                                                                                                        | Live                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| Sites search, site page (quota, libraries) | `Sites.Read.All`                                                                                             | yes                              |
| Sharing page, Public and Anyone-link sites | Read app SharePoint `AllSites.FullControl` (delegated); SharePoint Administrator                             | yes (PnP through the runner)     |
| Give or remove access to a OneDrive        | Write app SharePoint `AllSites.FullControl`; `User.Read.All`; SharePoint Administrator; `AF_SPO_TENANT_NAME` | refusals only (no test OneDrive) |
| SharePoint file round trip (synthetic)     | Automation identity `Sites.Selected` and a write grant on one test site                                      | not configured                   |

## Teams

| Feature                                         | Needs                                                                                                    | Live                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Teams list, team page (owners, members, guests) | `Group.Read.All`, `GroupMember.Read.All`; no licence for the viewer                                      | yes                                   |
| Team settings and channels                      | `Team.ReadBasic.All`, `TeamSettings.Read.All`, `Channel.ReadBasic.All` and a Teams licence on the person | refused for unlicensed people         |
| Teams without owners (weekly schedule)          | Automation identity `Group.Read.All`, `GroupMember.Read.All`, `Team.ReadBasic.All`                       | yes                                   |
| Teams policies for a user (preview)             | `teams`; Teams `user_impersonation`; Teams Administrator, Communications Administrator or Global Reader  | no: the module fails with real tokens |
| Teams meeting (synthetic)                       | A Teams-licensed test user; `OnlineMeetings.ReadWrite.All` (write opt-in); an application access policy  | not configured                        |

## Microsoft 365 usage, service health and Message center

| Feature                                                     | Needs                                                                                    | Live                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------ |
| Usage reports (overview, usage pages, inactive licensed)    | `Reports.Read.All` (+ `ReportSettings.Read.All`); Reports Reader or Global Reader        | not yet: 404 `UnknownTenantId` |
| Service health, issues, Message center, licence utilisation | `ServiceHealth.Read.All`, `ServiceMessage.Read.All`, `Organization.Read.All`; no licence | yes                            |
| Message center data-privacy posts                           | App-only visibility undocumented, so Portal.Admin only                                   | not checked                    |

Usage reports start 24–48 hours after a tenant's first Microsoft 365 subscription; with concealed names (the report
privacy setting) the pages handle hashed names.

## Intune

| Feature                                                    | Needs                                                                                                    | Live                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------- |
| Apps, compliance and configuration policies, reports       | `intune`; `DeviceManagementApps.Read.All`, `DeviceManagementConfiguration.Read.All`                      | yes                         |
| Devices, device pages, device actions, device filters      | `intune`; `DeviceManagementManagedDevices.Read.All` (actions: the Write app's)                           | blocked: no enrolled device |
| Connector and token health (ADE, VPP, Managed Google Play) | `intune`; `DeviceManagementServiceConfig.Read.All` (ADE, Google Play and Autopilot settings are beta)    | yes (nothing configured)    |
| Compliance summaries, Autopilot (schedules, app-only)      | `intune`; application `DeviceManagementConfiguration.Read.All`, `DeviceManagementServiceConfig.Read.All` | requests accepted           |
| BitLocker key escrow                                       | `intune`; `BitlockerKey.ReadBasic.All` (metadata only), `DeviceManagementManagedDevices.Read.All`        | path only (403 app-only)    |
| Windows LAPS coverage                                      | `DeviceLocalCredential.ReadBasic.All` (metadata only), `Device.Read.All`                                 | path only (403 app-only)    |

## Azure

| Feature                                         | Needs                                                                                 | Live                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------- |
| Inventory, RBAC, Resource Graph, Monitor        | An Azure subscription; Reader                                                         | yes (earlier tenant)         |
| Advisor recommendations                         | Free; Reader                                                                          | yes (earlier tenant)         |
| Defender for Cloud plans and recommendations    | Reader; Foundational CSPM is free, alerts need paid plans                             | yes (earlier tenant)         |
| Azure Backup coverage                           | Reader on the vaults                                                                  | query accepted, no data      |
| Azure Service Health                            | Reader per subscription; advisory details: Service Health Security Reader             | yes (earlier tenant)         |
| Scheduled Azure coverage                        | The automation identity's Reader: provisioning grants it on `AF_SUBSCRIPTION_ID` only | —                            |
| Remove a role assignment (the role's name)      | Reader at the assignment's scope                                                      | not run                      |
| Resource and role-assignment lookups (`$kql()`) | Reader                                                                                | not run (changed 2026-10-21) |

The validation tenant had one pay-as-you-go subscription on 2026-10-15 and none since 2026-10-17, so everything Azure
added after that date is fixture-only.

## Azure Billing

Fixture-validated only: no Cost Management, forecast or Billing request has run against Azure since the views were
built (`docs/operations.md` › Azure Billing).

| Feature                                         | Needs                                                                                                 | Live                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------- |
| Cost Management query and forecast              | An offer with Cost Management (EA, MCA, pay-as-you-go; not most CSP, sponsorship or Open); free       | fixtures only        |
| Management-group scope (default: tenant root)   | Cost Management Reader or Reader on the group; at most 3,000 subscriptions; MCA: check once           | fixtures only        |
| Billing-account scope (`AF_BILLING_ACCOUNT_ID`) | EA: enterprise administrator (read) or department or account reader; MCA: Billing account reader      | fixtures only        |
| Forecast, amortized cost, tags                  | Forecast not on every offer (straight-line fallback); amortized: EA and MCA; resource tags only       | fixtures only        |
| Budgets                                         | Reader on the subscription; subscription-scope budgets only                                           | yes (earlier tenant) |
| Invoices                                        | MCA and pay-as-you-go accounts; Billing account reader or Invoice manager (EA invoices aren't listed) | fixtures only        |
| Monthly cost schedule                           | Automation identity: Cost Management Reader on the management group (assigned by hand today)          | —                    |

Cost Management allows a few queries a minute per scope (the earlier tenant answered 429 after two), so every view
caches for an hour.

## Hybrid Azure Arc servers

Fixture-validated only: no Arc-enabled server exists to query (`docs/operations.md` › Azure Arc servers).

| Feature                                | Needs                                                                                                | Live          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------- |
| Arc servers, agents, connection, sites | Reader; Arc itself is free, extensions and services bill separately                                  | fixtures only |
| Extensions                             | Reader                                                                                               | fixtures only |
| Update Manager patching                | Reader; periodic assessment on (Azure Policy), `Microsoft.Compute` registered; billed per server-day | fixtures only |
| Defender for Servers coverage          | Reader or Security Reader; Defender for Servers Plan 1 or 2 per server                               | fixtures only |
| ESU (Windows Server 2012 and 2012 R2)  | ESUs enabled by Azure Arc are paid per core                                                          | fixtures only |

Update Manager is free for a server with ESUs enabled by Arc, in a subscription with Defender for Servers Plan 2, or
covered by Windows Server Software Assurance or pay-as-you-go by Arc.

## Azure Virtual Desktop

Fixture-validated only: no host pool exists to query (`docs/operations.md` › Azure Virtual Desktop).

| Feature                                                   | Needs                                                                                  | Live          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------- |
| Host pools, application groups, workspaces, scaling plans | Reader or Desktop Virtualization Reader; AVD is free, session host machines bill       | fixtures only |
| Session hosts, user sessions                              | Reader or Desktop Virtualization Reader                                                | fixtures only |
| Drain mode                                                | Desktop Virtualization Session Host Operator (or Contributor)                          | fixtures only |
| Messages and sign-outs                                    | Desktop Virtualization User Session Operator (or Contributor)                          | fixtures only |
| Connection diagnostics                                    | Host pool diagnostic settings to `AF_AVD_LOG_ANALYTICS_WORKSPACE_ID`; billed per GB    | fixtures only |
| People who connect                                        | An AVD access right each (checked by Microsoft; AdminForge neither reads nor gates it) | —             |

## Synthetic monitoring

| Check                                                          | Needs                                                                                  | Live           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------- |
| Front doors (Autodiscover, Outlook, SharePoint, Teams, portal) | Nothing (anonymous https); `AF_SPO_TENANT_NAME`, `AF_MAIL_DOMAIN`                      | yes            |
| Open incidents per workload, services interrupted              | `ServiceHealth.Read.All`                                                               | yes            |
| Sign-in failure rate per workload                              | `signInLogs`; `AuditLog.Read.All`                                                      | yes            |
| Intune through Graph; Teams channels of a test team            | `intune` and `DeviceManagementManagedDevices.Read.All`; a team and `Group.Read.All`    | yes            |
| Mail flow (transaction)                                        | Exchange Online mailboxes (a shared mailbox is enough); Exchange RBAC for Applications | not configured |
| SharePoint file round trip, Teams meeting (transactions)       | See [SharePoint and OneDrive](#sharepoint-and-onedrive) and [Teams](#teams)            | not configured |

`Sites.Selected` is granted by `provision entra` without an opt-in (it reaches only the sites granted to it);
`OnlineMeetings.ReadWrite.All` is withheld unless `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS` is set. `Presence.Read.All`
was dropped: it reads everyone's presence.

## News and changes

| Source                                          | Needs                                                                           | Live |
| ----------------------------------------------- | ------------------------------------------------------------------------------- | ---- |
| Message Center                                  | `ServiceMessage.Read.All` (application, in the automation baseline); no licence | yes  |
| Service health                                  | `ServiceHealth.Read.All` (application, in the automation baseline); no licence  | yes  |
| Azure Service Health (`servicehealthresources`) | Reader per subscription; advisory details: Service Health Security Reader       | yes  |
| Public feeds (Azure Updates, Roadmap, MSRC, …)  | Nothing (outbound https to the feed hosts)                                      | yes  |

## Delivery and notifications

| Feature                                         | Needs                                                                      | Live                      |
| ----------------------------------------------- | -------------------------------------------------------------------------- | ------------------------- |
| Email delivery, failure alerts, approver e-mail | An Exchange Online mailbox for `AF_MAIL_SENDER`; `Mail.Send` (application) | not checked (unit-tested) |
| Teams delivery                                  | A Teams Workflows webhook                                                  | not checked (unit-tested) |

## Tenant set-up

| What                                            | Needs                                                                                             | Live     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------- |
| Portal roles through `SG-AdminForge-*` groups   | Group-based app assignment (works on Entra ID Free)                                               | yes      |
| Write step-up                                   | Entra ID P1 authentication context (`WRITE_AUTH_CONTEXT`); without it a fresh interactive sign-in | fallback |
| Exchange, Teams and SharePoint scopes           | The workloads' service principals (they appear with the licences); then `provision entra` again   | yes      |
| Validation user's MFA under Security Defaults   | A TOTP authenticator the live helper registers (seed in local configuration only)                 | yes      |
| Azure test environment (`provision azure-test`) | A Log Analytics workspace with a 0.1 GB daily cap (within the free allowance)                     | yes      |

## Microsoft Defender (retired)

AdminForge no longer reads the Microsoft Defender portal (owner decision, 2026-10-17): its incidents, alerts, hunting,
Secure Score and device content is retired, and `provision entra` no longer grants its permissions. Defender for Cloud
(Azure) and the public Defender news feeds stay. What the content needed, and what to check if it comes back, is in
its [finding](licensing/findings/2026-10-16-defender-office-365-e5.md).

| Feature (retired)                   | Needs                                                                                              | Live                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------- |
| Incidents, alerts, advanced hunting | `defender`, and Defender XDR set up for the tenant; `SecurityIncident.*`, `ThreatHunting.Read.All` | blocked: XDR not set up |
| Device data and vulnerabilities     | `defenderEndpoint`                                                                                 | gate checked            |
| Secure Score                        | No licence; `SecurityEvents.Read.All`                                                              | yes                     |

## Previews

Definitions flagged `preview: true` (listed by `adminforge validate`): built, but not yet confirmed to work against a
live tenant. Remove the flag with a version bump once they do.

| Definition                 | Why                                                                                                                     | Remove when               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `m365.teams-user-policies` | `Get-CsOnlineUser` fails inside the Teams PowerShell module with real tokens; the script reports it as "user not found" | the Teams read works live |

## Findings

| Date       | Finding                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-15 | [Validation tenant](licensing/findings/2026-10-15-validation-tenant.md)                                                        |
| 2026-10-15 | [Mailbox, Teams, OneDrive and vulnerability features](licensing/findings/2026-10-15-mailbox-teams-onedrive-vulnerabilities.md) |
| 2026-10-15 | [Directory roles, PIM eligibility, app access and groups](licensing/findings/2026-10-15-roles-pim-app-access-groups.md)        |
| 2026-10-15 | [Report library: Microsoft 365, endpoint and security](licensing/findings/2026-10-15-report-library-m365-endpoint-security.md) |
| 2026-10-15 | [Report library: identity](licensing/findings/2026-10-15-report-library-identity.md)                                           |
| 2026-10-15 | [Report library: Azure](licensing/findings/2026-10-15-report-library-azure.md)                                                 |
| 2026-10-15 | [News and changes](licensing/findings/2026-10-15-news-and-changes.md)                                                          |
| 2026-10-16 | [Microsoft Defender with Office 365 E5](licensing/findings/2026-10-16-defender-office-365-e5.md)                               |
| 2026-10-16 | [Teams, SharePoint, OneDrive and Microsoft 365 usage](licensing/findings/2026-10-16-teams-sharepoint-onedrive-usage.md)        |
| 2026-10-16 | [Exchange Online with Office 365 E5](licensing/findings/2026-10-16-exchange-online.md)                                         |
| 2026-10-16 | [Entra ID P1, P2 and Intune with Microsoft 365 E5](licensing/findings/2026-10-16-entra-p1-p2-intune.md)                        |
| 2026-10-17 | [Engineer report library](licensing/findings/2026-10-17-engineer-report-library.md)                                            |
| 2026-10-17 | [Synthetic monitoring of Microsoft 365](licensing/findings/2026-10-17-synthetic-monitoring.md)                                 |
| 2026-10-17 | [Azure Billing](licensing/findings/2026-10-17-azure-billing.md)                                                                |
| 2026-10-17 | [Hybrid Azure Arc servers at scale](licensing/findings/2026-10-17-azure-arc-servers.md)                                        |
| 2026-10-17 | [Azure Virtual Desktop](licensing/findings/2026-10-17-azure-virtual-desktop.md)                                                |
| 2026-10-21 | [Platform review: requests and permissions not yet checked live](licensing/findings/2026-10-21-platform-review.md)             |
| 2026-10-22 | [Protected-object guard: Graph path forms checked live](licensing/findings/2026-10-22-protected-guard-paths.md)                |
| 2026-10-22 | [Self-benefit gates: requests not yet checked live](licensing/findings/2026-10-22-self-benefit-gates.md)                       |
