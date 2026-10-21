# Validation tenant findings (2026-10-15)

> Licensing finding of 2026-10-15: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

- **Microsoft 365 / Entra licences**
  - Finding: **No subscribed SKUs** in the validation tenant
  - Impact: Everything below that needs a licence
  - Built anyway?: Yes — fixtures + "Requires licence" states
  - To unblock: Add trial/dev licences (e.g. Microsoft 365 E5 developer or trial; Entra ID P2; Intune)
- **Entra ID P1**
  - Finding: Not licensed
  - Impact: Conditional Access (read/manage/what-if), CA authentication context for write step-up, sign-in activity
    (`signInActivity`), group-based licensing, dynamic groups
  - Built anyway?: Yes. Write step-up falls back to a fresh interactive sign-in (`prompt=login`, `max_age=0`)
  - To unblock: Entra ID P1 or higher
- **Entra ID P2**
  - Finding: Not licensed
  - Impact: PIM (eligible roles, activation), Identity Protection (risky users/sign-ins), access reviews
  - Built anyway?: Yes (fixture-backed); PIM pages show eligibility as unavailable
  - To unblock: Entra ID P2 / Entra ID Governance
- **Exchange Online**
  - Finding: No mailbox licences → no Exchange organization data
  - Impact: Mailboxes, distribution lists, mail-enabled security groups, shared mailboxes, mail flow
  - Built anyway?: Yes — runner + fixtures; live tests skipped
  - To unblock: Exchange Online (Plan 1+) or M365 licence
- **Teams**
  - Finding: Not licensed
  - Impact: Teams inventory, policies, Teams admin PowerShell
  - Built anyway?: Yes (fixtures)
  - To unblock: Microsoft 365 / Teams licence
- **SharePoint / OneDrive**
  - Finding: Not licensed
  - Impact: Sites, sharing settings, OneDrive
  - Built anyway?: Yes (fixtures)
  - To unblock: SharePoint Online / M365 licence
- **Intune**
  - Finding: Not licensed (`deviceManagement` returns 400)
  - Impact: Managed devices, compliance, configuration, apps, device actions
  - Built anyway?: Yes (fixtures)
  - To unblock: Intune Plan 1 (or M365 E3/E5/EMS)
- **Defender XDR**
  - Finding: Not licensed (`security/incidents` 403)
  - Impact: Incidents, alerts, advanced hunting
  - Built anyway?: Yes (fixtures)
  - To unblock: Defender for Endpoint/Office/Identity or M365 E5
- **Service health / message center**
  - Finding: 403 for the app identity
  - Impact: Service health dashboard, message center
  - Built anyway?: Yes — delegated reads use the engineer's role; app-only schedules need `ServiceHealth.Read.All`
  - To unblock: Granted to the automation identity by provisioning
- **Azure Arc**
  - Finding: Resource provider `Microsoft.HybridCompute` not registered; no connected machines
  - Impact: Arc servers inventory, extensions, patching, Defender coverage
  - Built anyway?: Yes — Resource Graph pages + fixtures
  - To unblock: Register the provider and onboard a test machine (any Linux or Windows server)
- **Azure (general)**
  - Finding: One Pay-As-You-Go subscription, minimal resources
  - Impact: Inventory, RBAC, monitoring validated live; Function Apps/Log Analytics need test resources
  - Built anyway?: Yes
  - To unblock: Optional low-cost test resources in an `AF-Test-*` resource group
- **Azure test environment (cost)**
  - Finding: `pnpm adminforge provision azure-test` created resource group `AF-Test-<label>` with Log Analytics
    workspace `af-test-law-<label>` (PerGB2018, 30-day retention) receiving the subscription activity log (diagnostic
    setting `adminforge-<label>`)
  - Impact: Ingestion has a **daily cap of 0.1 GB** (at most ~3 GB a month, within the free 5 GB/month PerGB2018
    allowance; activity-log ingestion into Log Analytics is free)
  - Built anyway?: —
  - To unblock: `pnpm adminforge provision azure-test --destroy` removes it
- **Exchange / Teams / SharePoint resource principals**
  - Finding: The _Office 365 Exchange Online_, Teams admin, and SharePoint service principals don't exist in the
    tenant
  - Impact: `Exchange.Manage` (Read/Write apps) and Teams/SPO admin scopes skipped by provisioning
  - Built anyway?: Yes — runner + fixtures
  - To unblock: Licence the workloads; re-run `pnpm adminforge provision entra` (it adds the skipped scopes
    automatically)
- **Security Defaults**
  - Finding: **Enabled**
  - Impact: The validation user must register MFA on first sign-in, which blocks unattended browser sign-in
  - Built anyway?: Yes — the live E2E helper registers a TOTP authenticator for the dedicated test user on first run
    and generates codes afterwards (seed kept in local config only)
  - To unblock: Nothing required; alternatively use Conditional Access (P1) to scope MFA policy
- **Group-based app assignment**
  - Finding: Verified working: the validation user receives all portal roles in the ID token through `SG-AdminForge-*`
    group assignments
  - Impact: None observed
  - Built anyway?: —
  - To unblock: Nothing
- **Microsoft Defender for Cloud**
  - Finding: `Microsoft.Security` registered (free tier)
  - Impact: Recommendations/secure score available; alerts need paid plans
  - Built anyway?: Yes
  - To unblock: Enable Defender plans for alert coverage
