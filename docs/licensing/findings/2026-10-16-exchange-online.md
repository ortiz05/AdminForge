# Exchange Online with Office 365 E5 (2026-10-16)

> Licensing finding of 2026-10-16: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

Exchange Online is licensed for one mailbox (the owner's, read-only for testing). Checked live through the PowerShell
runner with the validation user (Exchange Recipient Administrator + Global Reader, no mailbox); writes only on the
AF-Test shared mailboxes and distribution list, each reversed afterwards.

- **Runner connection to Exchange Online**
  - Needs: Read/Write app `Exchange.Manage`; an Exchange role on the person
  - Verified live: Yes. Right after the role is assigned (and after organization customization)
    `Connect-ExchangeOnline` fails with "Module could not be correctly formed" — Exchange RBAC propagation; it worked
    about an hour later without any change
- **Mailboxes, Shared mailboxes, Shared mailboxes with sign-in allowed, Mailbox page (settings, Access tab)**
  - Needs: `exchange`; View-Only Recipients (Global Reader) or higher
  - Verified live: Yes — counts, types, sign-in state (Entra `accountEnabled` through Graph `getByIds`,
    `User.Read.All`; Exchange's `AccountDisabled` lagged more than 20 minutes behind it, 2026-10-17), forwarding,
    automatic replies, Full Access / Send As / Send on Behalf
- **Distribution lists, list page (settings, members, member counts)**
  - Needs: `exchange`; Graph `Group.Read.All`, `GroupMember.Read.All`
  - Verified live: Yes. The list page's members never loaded before (fixed)
- **Mail forwarding page, Mailbox external forwarding report, inbox-rule audit (incl. hidden rules)**
  - Needs: `exchange`; `Get-InboxRule` needs Mail Recipients (Exchange Recipient Administrator)
  - Verified live: Yes. Empty results failed before (fixed). Every mailbox has Exchange's hidden "Junk E-mail Rule";
    it is flagged hidden and can't be changed
- **Add / remove distribution list members**
  - Needs: Write app `Exchange.Manage`; Exchange Recipient Administrator (or list owner)
  - Verified live: Yes — added and removed a shared mailbox on the AF-Test list
- **Grant / remove Full Access, Send As, **Send on Behalf** (new)**
  - Needs: as above + Graph `User.Read.All` (the mailbox's and the person's object ids); removing also
    `Group.Read.All` (a group trustee's id)
  - Verified live: Yes — all three granted and removed between the AF-Test shared mailboxes. Granting failed for
    anyone without existing access before (Exchange answers NotFound; fixed). Review fixes (grant/remove 1.1.1): Full
    Access and Send As granted and removed again with the object ids checked by the script; the grant's read-back
    didn't show within ~9 s and said so, the removal found and removed both. Granting yourself is refused
- **Automatic replies (on, for a period, off), hide / show in address lists**
  - Needs: as above
  - Verified live: Yes. Automatic replies "for a period" were refused before (the runner turned the dates into
    DateTime; fixed)
- ****Forward a mailbox** inside the organization (new), Clear forwarding**
  - Needs: as above; Graph `User.Read.All` (object ids of the mailbox and the target). 1.1: a second engineer with
    `Playbook.Approver` (armed, Exchange Recipient Administrator) approves and runs the change
  - Verified live: 1.0: forwarded to a shared mailbox and to the distribution list, cleared again. 1.1 (approval,
    user/shared mailboxes only): the preview plans the write with both object ids; the run waits for approval, the
    request can't be approved by the validation user (no `Playbook.Approver`; the API also refuses approving your own
    run, `own_run`) and was cancelled — nothing changed. A group (the AF-Test list), the mailbox itself, yourself and
    an outside address are refused in the preview. The write after approval needs a second validation identity
- ****Turn an inbox rule off / on, remove it** (new, row actions on the inbox-rule audit)**
  - Needs: as above + Graph `User.Read.All` (the mailbox's object id)
  - Verified live: Partly: lookup, refusals (unknown and hidden rules, re-checked 1.0.1) and the cmdlet parameters
    (`-Mailbox -Identity -Force`) are confirmed; no visible rule exists on a test mailbox and none can be created from
    AdminForge, so the change itself — and the refusal to turn on a rule that forwards outside the organization — is
    fixture- and Pester-validated only
- **Convert to shared mailbox (also from offboarding)**
  - Needs: as above + Graph `User.Read.All`
  - Verified live: Refusal path only (the only user mailbox is the owner's). The mailbox type is now read from
    Exchange: Graph `mailboxSettings/userPurpose` answers ErrorAccessDenied for anyone else's mailbox with delegated
    permissions
- **Mailbox storage and inactivity report + weekly schedule**
  - Needs: Graph `Reports.Read.All`
  - Verified live: **Not yet:** 404 `UnknownTenantId` (usage reports start 24–48 h after the first subscription), for
    the user and the automation identity
- **Weekly external forwarding and shared-mailbox sign-in schedules**
  - Needs: App-only Exchange in the runner (`Exchange.ManageAsApp`, certificate, Exchange role)
  - Verified live: Disabled; a one-off run reports `runner_unsupported` as expected

Offboarding's mailbox steps (convert, automatic reply, hide) run the playbooks above; the test users have no mailbox,
so `identity.offboard-user` skips them on test identities. Its `MailboxSettings.Read` scope is no longer needed.
