# Report library: identity (2026-10-15)

> Licensing finding of 2026-10-15: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

- **Entra directory audit log (`auditLogs/directoryAudits`)**
  - Finding: Works without P1 (7-day retention; 30 days with P1); `$filter` supports `or` and `startswith`, not `in`
  - Affects: High-impact directory changes, AdminForge role group changes
  - Built anyway?: Yes — validated live
  - To unblock: P1 only for the 30-day window
- **PIM read endpoints (`roleEligibilityScheduleInstances`, `roleAssignmentScheduleInstances`)**
  - Finding: `AadPremiumLicenseRequired` for the automation identity; `RoleManagement.Read.Directory` is enough
    app-only
  - Affects: Eligible rows in Privileged role assignments and its weekly schedule
  - Built anyway?: Yes — standing assignments only
  - To unblock: Entra ID P2
- **Conditional Access policies (app-only)**
  - Finding: Returns an empty list (no error) without P1
  - Affects: Identity settings baseline, "Conditional Access policies enforced" row
  - Built anyway?: Yes
  - To unblock: Entra ID P1
- **Exchange / SharePoint application permissions**
  - Finding: Their service principals don't exist (404)
  - Affects: Exchange and SharePoint rows in Application permissions
  - Built anyway?: Yes — Graph rows validated live
  - To unblock: Exchange / SharePoint licences
- **Sign-in activity, MFA registration report**
  - Finding: Premium licence required
  - Affects: `inactive-users-weekly`, `users-without-mfa-weekly`
  - Built anyway?: Yes — gated by `requires.licences: [signInLogs]`
  - To unblock: Entra ID P1
