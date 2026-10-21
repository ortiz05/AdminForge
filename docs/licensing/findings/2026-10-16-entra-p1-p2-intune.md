# Entra ID P1, P2 and Intune with Microsoft 365 E5 (2026-10-16)

> Licensing finding of 2026-10-16: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

Microsoft 365 E5 (`SPE_E5`) includes Entra ID P1 and P2 and Intune. Checked live (plan Phase 2, areas 2a–2c) with
the validation user (User Administrator, Global Reader, Message Center Reader eligible) against the Phase 1 fixtures
(test licences, PIM eligibility, `AF-Test-Location`, the AF-Test Intune policies) and 14 report-only `AF-Audit:`
Conditional Access policies. 31 list pages, dashboards and reports (63 datasources), 9 entity pages, 2 probes and
8 report schedules: all read paths work. Defender XDR (area 2d) was dropped: the Defender portal content is retired.

- **Conditional Access policies (list and policy page), named locations**
  - Needs: `conditionalAccess` (P1); Graph `Policy.Read.All`
  - Verified live: Yes — 14 report-only policies, every policy page; the named location (IP range, not trusted).
    Report-only policies and named locations can be created while Security Defaults is on
- **Sign-ins (list and sign-in page), sign-in health probes**
  - Needs: `signInLogs` (P1); `AuditLog.Read.All`; Reports Reader or Global Reader
  - Verified live: Yes. The sign-in page used `GET /auditLogs/signIns/{id}`, which took ~165 s and then failed
    (`upstream_unreachable`) — the inspector kept loading. It now filters the list on the id, bounded to ±5 min of the
    sign-in's time (`at`): ~1–2 s, found or not (1.1.0); links without `at` search the last 7 days (a missing id ~9 s;
    over 30 days it timed out)
- **Authentication methods registration, users without MFA, the users page MFA filter**
  - Needs: `signInLogs` (P1); `AuditLog.Read.All`
  - Verified live: Requests work; `userRegistrationDetails` is still empty for this tenant (Microsoft fills the report
    in after licensing — re-check after 24–48 h)
- **Inactive users and guests (signInActivity)**
  - Needs: `signInLogs` (P1)
  - Verified live: Yes; 0 rows is correct (the test accounts were created today)
- **Directory roles, role page, PIM (mine and tenant), privileged role assignments**
  - Needs: `pim` (P2) for eligibility; `RoleManagement.Read.Directory`, `RoleEligibilitySchedule.Read.Directory`
  - Verified live: Yes — the two fixture eligibilities show on the role pages and in PIM. **PIM activation**
    (`identity.pim-activate`): the validation user activated Message Center Reader for 30 min (default role settings:
    no approval, no extra MFA prompt) and the pages showed it active
- **Add / remove role eligibility**
  - Needs: P2; `RoleEligibilitySchedule.ReadWrite.Directory`; Privileged Role Administrator; adding needs approval
  - Verified live: Preview only (both plan the write). Adding waits for a `Playbook.Approver`; not run for real
- **Risky users (list, report, schedule), Identity Protection on dashboards**
  - Needs: `identityProtection` (P2); `IdentityRiskyUser.Read.All`
  - Verified live: Yes (no risky users). The risky-user page needs a risky user (none yet)
- **Confirm compromised / dismiss risk, compromised-account runbooks**
  - Needs: P2; `IdentityRiskyUser.ReadWrite.All`; **Security Operator** (or Security Administrator) on the person
  - Verified live: Refused for the validation user (no Security Operator): Graph "Signed in user is missing required
    roles" — nothing changed. A user who was never at risk made the lookups fail with an unreadable 404; they now
    filter the list (dismiss 1.1.0 says "never been at risk")
- **Dynamic group membership (create / edit rule)**
  - Needs: P1; `Group.ReadWrite.All`
  - Verified live: Preview only: the create-group P1 check and rule checks pass. No dynamic AF-Test group to edit, and
    no delete-group playbook to undo a create
- **Intune apps, compliance and configuration (lists, policy pages), device and Autopilot reports**
  - Needs: `intune`; `DeviceManagementApps.Read.All`, `DeviceManagementConfiguration.Read.All`,
    `DeviceManagementManagedDevices.Read.All`
  - Verified live: Yes — both AF-Test policies and their status pages. Apps failed (`isAssigned` is beta-only on
    mobileApp; v1.0 now reads `assignments`, 1.0.1). Devices, device pages and device actions need an enrolled device
    (owner action 0.4)
