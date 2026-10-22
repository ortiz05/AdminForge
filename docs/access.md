# Access: roles and onboarding

AdminForge roles are Entra **app roles** on the AdminForge Read app, granted by membership of security groups that
provisioning creates (`SG-AdminForge-<label>-<Role>`, where `<label>` is `AF_ENV_LABEL`, e.g. `dev`). Roles are flat:
none implies another, so give each person every group they need.

| Role                | Group                                     | Lets the person                                                                                                                                                   |
| ------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Portal.Reader`     | `SG-AdminForge-<label>-Portal.Reader`     | Sign in, view pages, dashboards, reports and News and changes, preview (dry-run) playbooks. **Everyone needs this.**                                              |
| `Portal.Operator`   | `SG-AdminForge-<label>-Portal.Operator`   | Arm write access and run write playbooks; schedule reports (edit or delete their own); see scheduled report files and probe result rows                           |
| `Playbook.Approver` | `SG-AdminForge-<label>-Playbook.Approver` | Approve runs and enabling write-capable schedules (never their own requests, nor a change that grants them access); pause changes or automation in an emergency   |
| `Playbook.Author`   | `SG-AdminForge-<label>-Playbook.Author`   | Reserved for content authors; it grants nothing in the portal today (content is authored in git with Claude Code)                                                 |
| `Portal.Admin`      | `SG-AdminForge-<label>-Portal.Admin`      | Appearance (accent, radius, density, font size, default theme), installation settings, the audit log and its verification; pause and resume changes or automation |

Only the Operator group is assigned to the **Write** app, so Entra itself refuses write sign-ins for anyone else.

A `Portal.Admin` who is also an Operator can edit or delete anyone's report schedule created in the portal; any
Operator can turn one off.

## Typical combinations

| Person                     | Groups                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Help desk (look things up) | Reader                                                                                                          |
| Engineer who makes changes | Reader + Operator                                                                                               |
| Change approver            | Reader + Operator + Playbook.Approver (approvers must be armed when the steps after an approval write as them)  |
| Platform owner             | Reader + Operator + Portal.Admin                                                                                |
| Finance (Azure Billing)    | Reader, plus in Azure: Cost Management Reader on the cost management group, Billing account reader for invoices |
| Virtual desktop support    | Reader (+ Operator for drain mode, messages, sign-outs), plus the Azure Virtual Desktop roles below             |

Finance users see the Azure Billing section with their own Azure access (`docs/operations.md` › Azure Billing); they
need no AdminForge role beyond Reader, and Operator only to schedule billing reports themselves.

Azure Virtual Desktop works with the engineer's own Azure access as well (`docs/operations.md` › Azure Virtual
Desktop): **Desktop Virtualization Reader** (or Reader) on the host pools to see them, **Log Analytics Reader** on the
AVD workspace for Connections, and — with Operator, while armed — **Desktop Virtualization Session Host Operator** for
drain mode and **Desktop Virtualization User Session Operator** to send messages and sign users out (or Desktop
Virtualization Contributor for both). The ARM `user_impersonation` scope they use is already on both apps.

AdminForge never grants Entra privileges: a write still needs the person's own Entra role (for example User
Administrator, often activated through PIM). The portal explains when a role or licence is missing.

## Onboarding someone

1. Add their account to the groups above (Entra admin centre → Groups, or `az ad group member add`).
2. Ask them to sign in at the portal address. Membership changes apply within a few minutes; someone already signed
   in picks up new roles within 5 minutes.
3. If they see "You don't have access to AdminForge yet", the Details section shows the reference and Microsoft code;
   `docs/troubleshooting.md` lists what each means.

## Offboarding

Remove them from the groups (or disable the account). AdminForge re-checks roles every 5 minutes — in the browser
session and, for runs they started and left running, in the run worker: a session with no AdminForge role left ends,
and write access ends within 5 minutes of Operator being removed. Disabling the account ends the session at the next
check as well. Runs that were waiting for them to arm or sign in again stop after 24 hours.

## What the apps may do

AdminForge's three app registrations get only the permissions published content declares (`pnpm adminforge
validate --scopes` compares them), within ceilings that need a deliberate opt-in (`docs/operations.md`):

- **Read app** (everyone): read scopes, plus write-capable workload scopes that have no read-only equivalent —
  ARM `user_impersonation` (always), and on licensed tenants Exchange `Exchange.Manage`, SharePoint
  `AllSites.FullControl` and Teams `user_impersonation`. Provisioning flags them; AdminForge's read policy and the
  runner's read mode are what keep them read-only.
- **Write app** (Operators while armed): the scopes write playbooks declare. Tier-0 scopes — role management and PIM,
  app credentials and owners, app-role and consent grants, `Directory.AccessAsUser.All` (device deletion), tenant
  policies — only with `AF_ALLOW_PRIVILEGED_WRITE_SCOPES=true`. The lists are in
  `portal/tools/cli/src/provision/privilege.ts`.
- **Automation identity** (schedules): read-only application permissions; writes need
  `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true`, sensitive reads (mail, files, sites — full control of every site included — chats, calendars, call records, BitLocker keys, Windows LAPS passwords, …) need `AF_AUTOMATION_ALLOW_SENSITIVE_READS=true`, which the write opt-in doesn't replace. It requires assignment and can use a certificate instead of a
  secret. **Sites.Selected** (and the `…SelectedOperations.Selected` list and file permissions) is granted without
  the write opt-in: it reaches nothing until a SharePoint administrator grants the app one site.
  Synthetic monitoring adds, for the synthetic transactions (ADR-015), **Sites.Selected** with write on one test site, **OnlineMeetings.ReadWrite.All** (a write
  permission: only with the opt-in) narrowed by a Teams application access policy to one test user, and Exchange RBAC
  for Applications on the test mailbox ("Application Mail.ReadWrite") — no Entra mail permission
  (docs/operations.md › Synthetic transactions).
  News and changes (`docs/news.md`) adds no new kind of access: its tenant feeds declare **ServiceMessage.Read.All**
  (Message Center) and **ServiceHealth.Read.All** (Microsoft 365 service health) — read-only service-announcement
  permissions, granted without an opt-in — and read Azure Service Health with the identity's existing **Reader** on
  the subscriptions.
  Report schedules created in the portal: before each run the automation identity confirms that the person who
  created the schedule is still an enabled member holding the portal roles it needs. That reads the user
  (**User.Read.All**), their group memberships (**GroupMember.Read.All**) and the Read app's role assignments
  (**Application.Read.All**) — all in the default automation permission set.
- **Named app identities** (schedules that say `identity: { app: <name> }`, ADR-014): one app registration per name in
  `AF_SCHEDULE_IDENTITIES`, with only the application permissions of the schedules naming it, under the automation
  identity's ceilings plus opt-ins of its own (`AF_IDENTITY_<NAME>_ALLOW_*`) — so one team's schedules don't need the
  union of everyone's permissions. Any Operator may pick any configured identity for a report schedule. Tier-0 application permissions (role management, tenant policies and organization settings, authentication methods, group membership; `privilege.ts`) need `AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS=true` for every app-only identity.
- **A creator's own access** (portal report schedules set to "Run as: Me"): no new app or permission. The creator
  signs in once for the schedule through the Read app; it reads only what they can, never writes, and stops (the
  stored sign-in is deleted) when they lose `Portal.Operator` or a role the report needs, or the schedule is deleted,
  switched to another identity or changed by someone else. Only they (and Portal Admins) open its files. Offboarding
  someone therefore also ends their schedules' access.

## Who sees News and changes

Everyone with `Portal.Reader` sees the feed. Message Center posts Microsoft tags **Data privacy** are shown only to
`Portal.Admin` (in Microsoft 365 they are limited to Global Administrators and Message Center Privacy Readers). The
reason a feed failed (error code and message) is shown to `Portal.Operator`; everyone else sees only its status.

AdminForge never manages its own access. The executor refuses any change that names its own app registrations, the
groups (and any principal) assigned its app roles — the `SG-AdminForge-*` groups — the apps in `AF_PROTECTED_APP_IDS`
(the provisioner) or the accounts in `AF_PROTECTED_USER_IDS` (list your break-glass accounts there). Do those changes
in the Microsoft Entra admin center. Keep portal roles on groups: a person assigned an AdminForge app role directly
becomes a protected object themselves. To read this set, the automation identity needs **Application.Read.All** (or
each person's Read sign-in falls back to theirs).

## Separation of duties

- Nobody approves their own run or request, or a change that grants them access (the principal getting a directory
  or Azure role, people added to a role-assignable group, a new app owner).
- Adding someone to a role-assignable group and making someone an app owner always need a second person's approval;
  nobody can add themselves to an existing group or distribution list, assign themselves (or a group they belong to
  or own) to an enterprise app, or make themselves an owner through AdminForge. Creating a new group with yourself in
  it is allowed: it grants nothing until access is given to the group, which these rules then refuse.
- Temporary Access Passes, password resets and MFA resets are never for your own account, and never for the people
  who approve AdminForge changes (members of the Playbook Approver and Admin groups): change those in the Microsoft
  Entra admin center, by someone else.
- Forwarding a mailbox (`m365.set-mailbox-forwarding`) needs a second person's approval, and neither the person who
  receives the mail nor the mailbox's owner can approve it. Nobody forwards a mailbox to themselves or gives
  themselves access to a mailbox or someone's OneDrive through AdminForge.
- An approver or admin can **pause all changes or all automation** from Admin → Settings (with a reason, audited);
  only a `Portal.Admin` resumes.
- Content changes are meant to be reviewed: `adminforge publish` refuses content that isn't committed and on
  `origin/main` unless `--allow-unreviewed` is given (audited). Protect the branch and add a second code owner so the
  review is enforced by the repository, not only by the CLI.
