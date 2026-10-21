# Engineer report library (2026-10-17)

> Licensing finding of 2026-10-17: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

Plan 2026-10-17, phase E: eleven reports, six probes and three schedules for identity, Microsoft 365 and Intune
engineers. Every new Graph request was checked once against the validation tenant, read-only, as the automation
identity (app-only): the six probes ran with `run-schedule-once.ts --probe … --no-store` (4 ok, 2 warn — the SAML
fixture app expiring within 30 days and the suspended Office 365 E5 trial, both correct), the three schedules ran
once with delivery suppressed (succeeded), and each new report ran once through a temporary schedule (8 succeeded; the
BitLocker and LAPS reports need permissions the automation identity doesn't hold).

- **SAML signing certificate expiry (report, daily schedule, two probes)**
  - Needs: Free; `Application.Read.All`
  - Verified live: Yes — 1 SAML app
- **Subscription renewals and lapses (report, probe)**
  - Needs: Free; `Organization.Read.All` (report and probe alike)
  - Verified live: Yes — 2 subscriptions
- **Intune connector and token health (report, ADE and VPP probes)**
  - Needs: `intune`; `DeviceManagementServiceConfig.Read.All`, `DeviceManagementApps.Read.All`,
    `DeviceManagementConfiguration.Read.All` (Managed Google Play). ADE, Managed Google Play and Autopilot settings
    are Graph beta; the Apple push certificate and Autopilot settings answer 404 until configured
  - Verified live: Yes — nothing configured
- **Licence assignment errors**
  - Needs: Group-based licensing (P1); `Group.Read.All`, `User.Read.All`. Graph can't filter users on
    `licenseAssignmentStates` (not indexed): errors come from `hasMembersWithLicenseErrors` groups, one group at a
    time
  - Verified live: Yes — none
- **User attribute completeness**
  - Needs: Free; `User.Read.All` (`eq null` is an advanced query)
  - Verified live: Yes
- **Group lifecycle**
  - Needs: Free; Microsoft 365 group expiry and dynamic groups need Entra ID P1. `Group.Read.All`,
    `Directory.Read.All` (deleted groups). `expirationDateTime le …` works only as an advanced query;
    `owners/$count eq 1` can't be combined with `$expand=owners`
  - Verified live: Yes — 5 single-owner groups, nothing expiring
- **Unused applications**
  - Needs: `signInLogs` (P1); `AuditLog.Read.All`; `servicePrincipalSignInActivities` is Graph beta;
    `appOwnerOrganizationId` isn't filterable
  - Verified live: Yes — no activity yet in a 2-day-old tenant
- **Authentication method strength**
  - Needs: `signInLogs` (P1); `AuditLog.Read.All`. `methodsRegistered/any(…)` with `or` works, `not` and `all` are
    refused
  - Verified live: Yes
- **BitLocker recovery key escrow**
  - Needs: `intune`; `BitlockerKey.ReadBasic.All` (metadata only), `DeviceManagementManagedDevices.Read.All`;
    `isEncrypted` isn't filterable
  - Verified live: Path only — 403 for the automation identity
- **Windows LAPS coverage**
  - Needs: `DeviceLocalCredential.ReadBasic.All` (metadata only), `Device.Read.All`
  - Verified live: Path only — 403 for the automation identity
- **Conditional Access report-only impact**
  - Needs: `conditionalAccess` + `signInLogs` (P1); `AuditLog.Read.All`, `Directory.Read.All`, `Policy.Read.All`; for
    the Log Analytics path `Data.Read` and Log Analytics Reader on the workspace that receives the sign-in logs
    (optional: without it, or when it fails or is empty, the Graph sample of 300 sign-ins is used)
  - Verified live: Graph path yes — 14 policies; KQL path not (no workspace)
- **Licence seats nearly full or lapsed (probe, replaces the fixed E3/E5 probes)**
  - Needs: Free; `Organization.Read.All`
  - Verified live: Yes

New delegated scope for the Read app: `DeviceLocalCredential.ReadBasic.All` (Windows LAPS coverage). New application
permissions the automation identity would need to schedule the BitLocker and LAPS reports (not scheduled yet):
`BitlockerKey.ReadBasic.All`, `DeviceLocalCredential.ReadBasic.All`. Every other request uses permissions already
granted.
