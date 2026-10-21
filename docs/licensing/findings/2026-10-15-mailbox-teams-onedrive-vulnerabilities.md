# Mailbox, Teams, OneDrive and vulnerability features (2026-10-15)

> Licensing finding of 2026-10-15: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

Built and validated with fixtures and Pester only — the validation tenant has no Exchange, Teams, SharePoint, Intune
or Defender licences. Each is gated (`requires.licences`) and shows the "Requires …" state when the licence is
missing.

- **Mailbox page: settings and access (`m365.mailbox`); grant/remove Full Access and Send As**
  - Licence (service plan): Exchange Online (`exchange`)
  - Delegated permission / role: `Exchange.Manage`; Exchange Recipient Administrator (read: View-Only Recipients /
    Global Reader)
  - Live-validated: No
- **Clear forwarding, automatic replies, hide from address lists (also offboarding steps)**
  - Licence (service plan): Exchange Online (`exchange`)
  - Delegated permission / role: `Exchange.Manage`; Exchange Recipient Administrator. Synced accounts may need AD
    (`msExchHideFromAddressLists`)
  - Live-validated: No
- **Inbox rule audit (`m365.inbox-rules`)**
  - Licence (service plan): Exchange Online (`exchange`)
  - Delegated permission / role: `Exchange.Manage`; `Get-InboxRule` needs Mail Recipients (Exchange Recipient
    Administrator) or higher
  - Live-validated: No
- **Create shared mailboxes, room mailboxes and distribution lists; remove ones AdminForge created**
  - Licence (service plan): Exchange Online (`exchange`)
  - Delegated permission / role: `Exchange.Manage`; Exchange Recipient Administrator; allowing (or re-blocking)
    sign-in to a shared mailbox's account: `User.EnableDisableAccount.All` and User Administrator. People given access
    and list owners need a user mailbox; the engineer creating a list needs a mailbox (temporary owner); removing a
    list you don't own needs Organization Management
  - Live-validated: Yes (create and re-run, 2026-10-17)
- **Teams policies for a user (`m365.teams-user-policies`)**
  - Licence (service plan): Microsoft Teams (`teams`)
  - Delegated permission / role: Teams `user_impersonation` + Graph `User.Read.All`; Teams Administrator /
    Communications Administrator
  - Live-validated: No
- **Team page: team settings and channels now gated per datasource**
  - Licence (service plan): Microsoft Teams (`teams`)
  - Delegated permission / role: unchanged
  - Live-validated: No
- **Give the manager access to a OneDrive (`m365.grant-onedrive-access`, offboarding)**
  - Licence (service plan): SharePoint Online (`sharepoint`)
  - Delegated permission / role: SharePoint `AllSites.FullControl`; SharePoint Administrator; `AF_SPO_TENANT_NAME`
    must be set
  - Live-validated: No
- **Device vulnerabilities (`security.device-vulnerabilities`, advanced hunting `DeviceTvmSoftwareVulnerabilities`)**
  - Licence (service plan): Defender for Endpoint Plan 2 (`WINDEFATP`, in M365 E5) or Defender Vulnerability
    Management (`TVM_PREMIUM_1`)
  - Delegated permission / role: Graph `ThreatHunting.Read.All`; Security Reader. Defender for Endpoint P1 and
    Defender for Business don't include advanced hunting
  - Live-validated: No
- **Intune devices: query-builder filters**
  - Licence (service plan): Intune Plan 1 (`intune`)
  - Delegated permission / role: unchanged (`DeviceManagementManagedDevices.Read.All`)
  - Live-validated: No

New Write-app scopes declared by content (added by `pnpm adminforge provision entra`, verify with
`pnpm adminforge validate --scopes`): SharePoint `AllSites.FullControl` (OneDrive access). New Read-app scope:
Graph `ThreatHunting.Read.All` (delegated). Exchange `Exchange.Manage` and Teams `user_impersonation` were already
declared; their service principals are still missing in the validation tenant (see above).
