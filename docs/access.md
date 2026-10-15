# Access: roles and onboarding

AdminForge roles are Entra **app roles** on the AdminForge Read app, granted by membership of security groups that
provisioning creates (`SG-AdminForge-<label>-<Role>`, where `<label>` is `AF_ENV_LABEL`, e.g. `dev`). Roles are flat:
none implies another, so give each person every group they need.

| Role                | Group                                     | Lets the person                                                                                                           |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Portal.Reader`     | `SG-AdminForge-<label>-Portal.Reader`     | Sign in, view pages, dashboards and reports, preview (dry-run) playbooks. **Everyone needs this.**                        |
| `Portal.Operator`   | `SG-AdminForge-<label>-Portal.Operator`   | Arm write access and run write playbooks; see scheduled report files and probe result rows                                |
| `Playbook.Approver` | `SG-AdminForge-<label>-Playbook.Approver` | Approve runs and enabling write-capable schedules (never their own requests)                                              |
| `Playbook.Author`   | `SG-AdminForge-<label>-Playbook.Author`   | Reserved for content authors; it grants nothing in the portal today (content is authored in git with Claude Code)         |
| `Portal.Admin`      | `SG-AdminForge-<label>-Portal.Admin`      | Appearance (accent, radius, density, font size, default theme), installation settings, the audit log and its verification |

Only the Operator group is assigned to the **Write** app, so Entra itself refuses write sign-ins for anyone else.

## Typical combinations

| Person                     | Groups                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Help desk (look things up) | Reader                                                                                                         |
| Engineer who makes changes | Reader + Operator                                                                                              |
| Change approver            | Reader + Operator + Playbook.Approver (approvers must be armed when the steps after an approval write as them) |
| Platform owner             | Reader + Operator + Portal.Admin                                                                               |

AdminForge never grants Entra privileges: a write still needs the person's own Entra role (for example User
Administrator, often activated through PIM). The portal explains when a role or licence is missing.

## Onboarding someone

1. Add their account to the groups above (Entra admin centre → Groups, or `az ad group member add`).
2. Ask them to sign in at the portal address. Membership changes apply within a few minutes; someone already signed
   in picks up new roles within 5 minutes.
3. If they see "You don't have access to AdminForge yet", the Details section shows the reference and Microsoft code;
   `docs/troubleshooting.md` lists what each means.

## Offboarding

Remove them from the groups (or disable the account). AdminForge re-checks roles every 5 minutes: a session with no
AdminForge role left ends, and write access ends as soon as Operator is removed. Disabling the account ends the
session at the next check as well.

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
  `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true`, sensitive reads (mail, files, sites, chats, calendars, BitLocker keys,
  …) need `AF_AUTOMATION_ALLOW_SENSITIVE_READS=true`. It requires assignment and can use a certificate instead of a
  secret.

AdminForge never manages its own access: its playbooks refuse to change the `SG-AdminForge-*` groups, its own app
registrations and the apps in `AF_PROTECTED_APP_IDS` (the provisioner). Do that in the Microsoft Entra admin center.

**This installation:** `AF_ALLOW_PRIVILEGED_WRITE_SCOPES=true` (2026-10-15) — the identity playbooks for directory
roles, PIM eligibility, app access, consent grants, app owners and stale-device deletion need it. Review whether all
of them are wanted before go-live.
