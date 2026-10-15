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
