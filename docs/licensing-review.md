# Licensing and permission review

AdminForge keeps building and shipping features even when the validation tenant can't exercise them live.
Each blocked feature is fixture-backed, shows a clear **"Requires …"** state in the UI (with the SKU/service
plan), and is listed here for the owner to review. No tenant identifiers are recorded in this file.

## Validation tenant findings (2026-10-15)

| Area | Finding | Impact | Built anyway? | To unblock |
|---|---|---|---|---|
| Microsoft 365 / Entra licences | **No subscribed SKUs** in the validation tenant | Everything below that needs a licence | Yes — fixtures + "Requires licence" states | Add trial/dev licences (e.g. Microsoft 365 E5 developer or trial; Entra ID P2; Intune) |
| Entra ID P1 | Not licensed | Conditional Access (read/manage/what-if), CA authentication context for write step-up, sign-in activity (`signInActivity`), group-based licensing, dynamic groups | Yes. Write step-up falls back to a fresh interactive sign-in (`prompt=login`, `max_age=0`) | Entra ID P1 or higher |
| Entra ID P2 | Not licensed | PIM (eligible roles, activation), Identity Protection (risky users/sign-ins), access reviews | Yes (fixture-backed); PIM pages show eligibility as unavailable | Entra ID P2 / Entra ID Governance |
| Exchange Online | No mailbox licences → no Exchange organization data | Mailboxes, distribution lists, mail-enabled security groups, shared mailboxes, mail flow | Yes — runner + fixtures; live tests skipped | Exchange Online (Plan 1+) or M365 licence |
| Teams | Not licensed | Teams inventory, policies, Teams admin PowerShell | Yes (fixtures) | Microsoft 365 / Teams licence |
| SharePoint / OneDrive | Not licensed | Sites, sharing settings, OneDrive | Yes (fixtures) | SharePoint Online / M365 licence |
| Intune | Not licensed (`deviceManagement` returns 400) | Managed devices, compliance, configuration, apps, device actions | Yes (fixtures) | Intune Plan 1 (or M365 E3/E5/EMS) |
| Defender XDR | Not licensed (`security/incidents` 403) | Incidents, alerts, advanced hunting | Yes (fixtures) | Defender for Endpoint/Office/Identity or M365 E5 |
| Service health / message center | 403 for the app identity | Service health dashboard, message center | Yes — delegated reads use the engineer's role; app-only schedules need `ServiceHealth.Read.All` | Granted to the automation identity by provisioning |
| Azure Arc | Resource provider `Microsoft.HybridCompute` not registered; no connected machines | Arc servers/Kubernetes inventory, extensions | Yes — Resource Graph pages + fixtures | Register the provider and onboard a machine (this host could be onboarded) |
| Azure (general) | One Pay-As-You-Go subscription, minimal resources | Inventory, RBAC, monitoring validated live; Function Apps/Log Analytics need test resources | Yes | Optional low-cost test resources in an `AF-Test-*` resource group |
| Microsoft Defender for Cloud | `Microsoft.Security` registered (free tier) | Recommendations/secure score available; alerts need paid plans | Yes | Enable Defender plans for alert coverage |

## Feature → licence map (general)

| Feature | Requirement |
|---|---|
| Users, groups, roles, apps, devices (directory) | Entra ID Free |
| Sign-in logs | Entra ID P1 (Free tenants: limited) |
| Conditional Access, authentication context | Entra ID P1 |
| PIM, Identity Protection | Entra ID P2 |
| Exchange, Teams, SharePoint admin | The corresponding M365 workload licence |
| Intune | Intune Plan 1 |
| Defender incidents/alerts | Defender product licences / M365 E5 |
| Azure resources, Resource Graph, Monitor | Azure subscription + RBAC |
