# Directory roles, PIM eligibility, app access and groups (2026-10-15)

> Licensing finding of 2026-10-15: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

Built and covered by playbook tests and fixtures; live validation status in the validation tenant (no Entra ID P1/P2):

- **Assign / remove an active directory role (`identity.assign-directory-role`, `identity.remove-directory-role`)**
  - Needs: Entra ID Free; Write-app `RoleManagement.ReadWrite.Directory`
  - Live validation: Possible on `AF-Test-*` users (critical/high risk: approval required)
- **Add / remove PIM eligibility (`identity.add-role-eligibility`, `identity.remove-role-eligibility`), eligible
  tables on role/user pages, eligible part of the privileged-role report**
  - Needs: Entra ID P2 (PIM)
  - Live validation: **Blocked** — licence gate shown
- **Assign / remove app access, revoke a consent grant**
  - Needs: Entra ID Free; group assignment to apps needs P1
  - Live validation: User assignment possible; group assignment **blocked**
- **Create Microsoft 365 / dynamic groups, edit a dynamic rule (`identity.create-group`,
  `identity.edit-dynamic-rule`)**
  - Needs: Dynamic membership: Entra ID P1; Microsoft 365 groups provision fully with Exchange Online
  - Live validation: Security groups possible; dynamic **blocked** (clear refusal); M365 groups partial
- **Sign-ins advanced filter; sign-in reads in the compromised-account runbook**
  - Needs: Entra ID P1 (sign-in logs)
  - Live validation: **Blocked**
- **Identity Protection steps in the compromised-account runbook**
  - Needs: Entra ID P2
  - Live validation: **Blocked**
- **Email / Teams delivery, failure alerts, approver notifications**
  - Needs: Exchange Online mailbox for `AF_MAIL_SENDER` + Mail.Send; Teams (Workflows webhook)
  - Live validation: **Blocked** — unit-tested with fakes
