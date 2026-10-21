# Synthetic monitoring of Microsoft 365 (2026-10-17)

> Licensing finding of 2026-10-17: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

Service checks per workload on Synthetic monitoring (docs/operations.md › Synthetic transactions). Each read-only
check ran once against the validation tenant as the automation identity (`run-schedule-once.ts --probe … --no-store`);
the transactions only up to "not configured" (no test objects exist yet).

- **Exchange Autodiscover, Outlook (MAPI) and Outlook on the web, SharePoint and Teams web front doors, the Microsoft
  365 web portal, Entra realm discovery**
  - Needs: Nothing (anonymous https). The SharePoint front door needs `AF_SPO_TENANT_NAME`; Autodiscover uses
    `AF_MAIL_DOMAIN`, else the primary domain
  - Verified live: Yes — all ok. SharePoint answers anonymous calls with 403 here (401 in other tenants): both
    accepted
- **Open incidents per workload (Exchange, SharePoint, OneDrive, Teams, Entra, Intune), services interrupted**
  - Needs: Free; `ServiceHealth.Read.All`. Microsoft now names OneDrive "Microsoft OneDrive" (fixtures and older
    content said "OneDrive for Business"): filter both
  - Verified live: Yes — 0 incidents; 6 services at `serviceDegradation` (advisories), so only `serviceInterruption`
    counts as down
- **Sign-in failure rate per workload (`signInHealth` `resourceId`)**
  - Needs: `signInLogs` (Entra ID P1); `AuditLog.Read.All`
  - Verified live: Yes — the filter is accepted; "insufficient data" (under 20 sign-ins an hour in the validation
    tenant)
- **Intune through Graph**
  - Needs: `intune`; `DeviceManagementManagedDevices.Read.All`
  - Verified live: Yes
- **Teams channels of a test team**
  - Needs: A team; `Group.Read.All` (held; Graph accepts it for channels — Channel.ReadBasic.All is narrower)
  - Verified live: Yes — with an AF-Test team for the run
- **Mail flow (transaction)**
  - Needs: Exchange Online mailboxes; the test mailbox can be a shared mailbox (no licence). Exchange RBAC for
    Applications, no Entra permission
  - Verified live: Not configured — needs `AF_SYNTHETIC_MAILBOX` and the "Application Mail.ReadWrite" scope
- **SharePoint file round trip (transaction)**
  - Needs: SharePoint Online; `Sites.Selected` + a write grant on one test site
  - Verified live: Not configured — needs `AF_SYNTHETIC_SITE_ID` and the site grant
- **Teams meeting (transaction)**
  - Needs: A Teams-licensed test user; `OnlineMeetings.ReadWrite.All` (write:
    `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true`) + a Teams application access policy
  - Verified live: Not configured — needs `AF_SYNTHETIC_USER_ID`, the permission and the policy

New application permissions content declares for the automation identity: `Sites.Selected` (granted by
`provision entra` without an opt-in; it reaches only the sites granted to it) and `OnlineMeetings.ReadWrite.All`
(withheld unless the write opt-in is set). A Teams presence check was tried and dropped: `Presence.Read.All` reads
everyone's presence and can't be narrowed to a test user (it is now a sensitive read).
