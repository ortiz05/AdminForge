# Report library: Microsoft 365, endpoint and security (2026-10-15)

> Licensing finding of 2026-10-15: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

Requests were checked read-only against the validation tenant; where a licence blocks data, Graph still validated the
request syntax (it checks `$select`/`$expand`/`$filter` before licensing).

- **Microsoft 365 usage reports (`getOffice365ActiveUserDetail`, `getMailboxUsageDetail`,
  `getTeamsTeamActivityDetail`, `getSharePointSiteUsageDetail`, `getOneDriveUsageAccountDetail`)**
  - Finding: 404 `UnknownTenantId` for the app identity (no Microsoft 365 subscription)
  - Affects: Inactive licensed users, mailbox storage, team activity, SharePoint and OneDrive usage reports
  - Built anyway?: Yes — fixture-backed; gated by `exchange`/`teams`/`sharepoint`
  - To unblock: Any Microsoft 365 subscription; data appears 24–48 h after activity
- **Secure Score (`security/secureScores`, `secureScoreControlProfiles`)**
  - Finding: 403 for both identities until `SecurityEvents.Read.All` is granted (provisioning adds it)
  - Affects: Secure Score summary report and schedule
  - Built anyway?: Yes
  - To unblock: `SecurityEvents.Read.All` (application) on the automation identity
- **Identity Protection (`identityProtection/riskDetections`, `riskyUsers`)**
  - Finding: 403 missing scope / not licensed
  - Affects: Risky users review report and schedule
  - Built anyway?: Yes — gated `identityProtection`
  - To unblock: Entra ID P2 + `IdentityRiskEvent.Read.All` (application)
- **Intune compliance summaries, Autopilot (app-only)**
  - Finding: 400 "not applicable" (no Intune); request syntax validated
  - Affects: Compliance policy gaps, Autopilot not enrolled
  - Built anyway?: Yes — gated `intune`
  - To unblock: Intune Plan 1 + `DeviceManagementConfiguration.Read.All` / `DeviceManagementServiceConfig.Read.All`
    (application)
- **Shared mailboxes with sign-in allowed (scheduled)**
  - Finding: Needs app-only Exchange (`Exchange.ManageAsApp`, a certificate, an Exchange role)
  - Affects: `shared-mailbox-sign-in-weekly` (disabled)
  - Built anyway?: Yes — interactive report works with Exchange
  - To unblock: Exchange Online + app-only Exchange setup
