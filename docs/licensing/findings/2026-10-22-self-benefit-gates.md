# Self-benefit gates: requests not yet checked live (2026-10-22)

> Licensing finding of 2026-10-22: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

The self-benefit refusals added after the 2026-10-22 security review (`CHANGELOG.md` › Nobody benefits from their own
change) were built and tested against fixtures, playbook tests and Pester stubs only. None of the requests below has
run against a tenant yet; run each once, read-only, in the validation tenant.

- **Graph, delegated, as the armed engineer (Write app; `Directory.Read.All` and `Application.Read.All` are already
  declared by other write content)**
  - `POST /users/{you}/checkMemberGroups` with one group id (`identity.assign-app-access`) and with up to 20
    (`identity.issue-tap`, `reset-password`, `reset-mfa`): answers the ids you (or the target) belong to.
  - `GET /groups/{id}/owners?$select=id` (`identity.assign-app-access`).
  - `POST /directoryObjects/getByIds` with `types: [user]` (`identity.add-group-members`): a group id must come back
    missing, not as a group.
  - `GET /servicePrincipals(appId='{AF_READ_CLIENT_ID}')?$select=id,appRoles` and
    `GET /servicePrincipals/{id}/appRoleAssignedTo?$select=principalId,principalType,appRoleId` (the credential
    playbooks): whether the engineer's delegated token may read the Read app's role assignments.
- **Exchange Online, as the engineer (runner)**
  - `Get-EXORecipient -Identity {object id} -Properties EmailAddresses[, LegacyExchangeDN]`: whether the object id
    finds the caller, and whether `LegacyExchangeDN` and `X500:` proxies come back in the form rule targets use
    (`[EX:/o=…]`).
  - `Get-EXORecipient -Identity {address}` for each address added to a mail-enabled security group: one call per
    address (up to 1,000); how long a large add takes is unmeasured.
