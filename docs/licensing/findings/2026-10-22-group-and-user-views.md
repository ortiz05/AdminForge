# Groups and Users views: requests checked live (2026-10-22)

> Licensing finding of 2026-10-22: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

The views added to `identity.groups` (1.3.0) and `identity.users` (1.4.0) on 2026-10-22
(`docs/plans/2026-10-22-group-and-user-views.md`). Every new Graph request ran once against the validation tenant,
read-only, as the **automation identity** (application permissions; counts and statuses only). All answered 200:

- **Groups** (`ConsistencyLevel: eventual`, `$count=true`): `owners/$count eq 0` and `eq 1`, also combined with
  `securityEnabled eq true and mailEnabled eq false` and a `$search`; `createdDateTime ge|le <date>`;
  `groupTypes/any(c:c eq 'DynamicMembership') and membershipRuleProcessingState eq 'Paused'`;
  `expirationDateTime le <date>`; `groupTypes/any(c:c eq 'Unified') and renewedDateTime le <date>`; the owner ids
  (`$select=id`, `$top=999`).
- **Every group with its members expanded** (no advanced query): `$select=<16 fields>&$expand=members($select=id)&$top=999`
  — expansions came back (at most 12 members on a group in this tenant; Graph documents 20 as the cap).
- **Users** (`eventual`, `$count`): `userType eq 'Guest' and externalUserState eq 'PendingAcceptance'`;
  `createdDateTime ge <date>`; `accountEnabled eq false and assignedLicenses/$count ne 0`.
- **Users, sign-in filter alone**: `signInActivity/lastSuccessfulSignInDateTime le <date>` with the page's `$select`
  and `$top=120` (no rows matched: the tenant is younger than 90 days). Needs Entra ID P1 (`signInLogs`) and
  `AuditLog.Read.All`, as the Users page already declares.

Not checked: the same requests **delegated**, as an engineer through the Read app (the pages' path; the permissions
are the ones the pages already declared, so only role trimming could differ), and any request at fleet size — the
tenant holds 19 groups and 24 users. Fleet size was measured on the synthetic tenant instead (`tests/perf`,
`content-at-scale-{groups,users}-views.scale.test.ts`). "Not changed in a year" was not built: this installation has
no Log Analytics workspace (`AF_LOG_ANALYTICS_WORKSPACE_ID`), and Entra keeps no last-modified time for a group.
