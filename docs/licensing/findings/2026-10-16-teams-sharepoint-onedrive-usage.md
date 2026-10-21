# Teams, SharePoint, OneDrive and Microsoft 365 usage with Office 365 E5 (2026-10-16)

> Licensing finding of 2026-10-16: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

The validation tenant now has Office 365 E5 (`ENTERPRISEPREMIUM`: `TEAMS1`, `SHAREPOINTENTERPRISE`, Exchange) with one
seat. The validation user is unlicensed (Global Reader, SharePoint Administrator). Checked live with the validation
user and the automation identity; writes only on the AF-Test team's site.

- **Teams list, team/group page (owners, members, guests), Teams KPIs on the Microsoft 365 overview**
  - Needs: Graph `Group.Read.All`, `GroupMember.Read.All`; no licence for the viewer
  - Verified live: Yes
- **Team settings and channels (`m365.team`), archive state (`m365.teams-without-owners`)**
  - Needs: Graph Teams APIs (`Team.ReadBasic.All`, `TeamSettings.Read.All`, `Channel.ReadBasic.All`) **and a Microsoft
    Teams licence on the signed-in person**
  - Verified live: Requests accepted; Microsoft refuses them for an unlicensed viewer ("Failed to get license
    information for the user"), now explained as such. The automation identity (application permission) reads the
    archive state
- **Teams without owners (`m365.teams-without-owners` 1.1, weekly schedule now enabled)**
  - Needs: Graph only (was Teams PowerShell); automation identity: `Group.Read.All`, `GroupMember.Read.All`,
    `Team.ReadBasic.All`
  - Verified live: Yes — delegated and automation identity; schedule run once on the dev database
- **Teams policies for a user (`m365.teams-user-policies`)**
  - Needs: Teams `user_impersonation`; Teams Administrator, Teams Communications Administrator or Global Reader
  - Verified live: **No.** The runner now connects (MicrosoftTeams 8 refuses `-TenantId` together with
    `-AccessTokens`); `Get-CsOnlineUser` then fails inside the module's proxy ("GetSteppablePipeline") with real
    tokens only — see the backlog
- **SharePoint sites search, site page (storage quota, libraries)**
  - Needs: Graph `Sites.Read.All`
  - Verified live: Yes
- **SharePoint sharing page, Public and Anyone-link sites (sharing part)**
  - Needs: SharePoint `AllSites.FullControl` (Read app, delegated); SharePoint Administrator
  - Verified live: Yes (PnP through the runner). The site list returns no owner for group-connected sites: rows link
    to the Microsoft 365 group instead
- **Give / remove someone's access to a OneDrive (`m365.grant-onedrive-access` 1.1.1, `m365.remove-onedrive-access`
  1.0.1)**
  - Needs: SharePoint `AllSites.FullControl` (Write app); Graph `User.Read.All`; SharePoint Administrator;
    `AF_SPO_TENANT_NAME`
  - Verified live: 1.1: add, read back and remove a site collection administrator verified on the AF-Test team's site.
    Since the review fixes the script works on OneDrives only (team sites are refused) and confirms the owner from
    their SharePoint profile (`PersonalUrl`, `msOnline-ObjectId`): Pester-validated; live, the refusals (no OneDrive,
    the owner, yourself) are verified. No test OneDrive exists
- **Microsoft 365 usage reports (`m365.usage`, overview chart, inactive licensed users, team activity, SharePoint site
  and OneDrive usage, Anyone-link counts)**
  - Needs: Graph `Reports.Read.All` (+ `ReportSettings.Read.All`); Reports Reader or Global Reader
  - Verified live: **Not yet.** Microsoft answers 404 `UnknownTenantId` to the validation user and the automation
    identity: the reports start 24–48 hours after the first subscription. The report privacy setting is on (names
    concealed); the reports handle hashed names
- **Service health, issue page, message center, message page, their reports, licence utilisation**
  - Needs: `ServiceHealth.Read.All`, `ServiceMessage.Read.All`, `Organization.Read.All`; no licence
  - Verified live: Yes. Service health KPIs now count every unresolved issue, whatever the table filters
