# Platform review: requests and permissions not yet checked live (2026-10-21)

> Licensing finding of 2026-10-21: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

The platform review's fixes (`docs/plans/2026-10-21-platform-review-implementation.md`) were built and tested against
fixtures and mock mode only: none of the Microsoft requests below has run against a tenant yet. The live checks still
to do are rows in `docs/backlog.md` (Security and Content).

- **Delegated permission grant guard** (`portal/apps/api/src/execution/protected.ts`)
  - Request: a write to `/oauth2PermissionGrants/{id}` (any path spelling, `$batch` included) first reads the grant,
    `GET /oauth2PermissionGrants/{id}?$select=id,clientId`, and is refused (`protected_object`) when its client is
    AdminForge's own app or one in `AF_PROTECTED_APP_IDS`.
  - Needs: `DelegatedPermissionGrant.Read.All` or `Directory.Read.All` — application permission on the automation
    identity (asked first), else delegated on the Read app as the engineer. Whether the automation identity holds
    either is unverified. Without a reader that can read the grant, every grant write fails closed
    (`protected_objects_unavailable`).
  - Affects: `identity.revoke-consent-grant` and any other write to a grant.
- **Role name in `azure.remove-role-assignment` 1.1.0** (its `role` step)
  - Request: `GET <assignment scope>/providers/Microsoft.Authorization/roleDefinitions/<id>?api-version=2022-04-01`,
    read at the assignment's own scope so it needs no access above it.
  - Needs: Reader (or any role with `Microsoft.Authorization/roleDefinitions/read`) at that scope — what reading the
    assignment already takes. If it can't be read, the confirmation asks for the assignment's GUID instead.
  - Live: not run; run it once, read-only.
- **Graph behaviour the new write guards assume** (S-15, S-31)
  - `user_not_by_id`: a write that names a user by sign-in name or address (in the path, an `@odata.id` /
    `…@odata.bind` reference or a `$id` query) is refused before it is sent; not yet seen on a real run.
  - The notify step's one-on-one Teams chat binds the member as a quoted OData literal (`users('o''brien%40…')`):
    whether Graph accepts the doubled apostrophe is unverified.
  - Whether Graph collapses `//` in a path, and honours `@id` / `@bind` (the OData 4.01 spellings), as the guard
    assumes.
  - Whether Graph decodes `%27` in a `$batch` url's `$filter` before parsing it (the injection lint assumes it does).
- **Tenant name at sign-in** (S-26)
  - Request: `GET /organization?$select=displayName,verifiedDomains` as the person signing in, now through the
    outbound executor with no retry and a 5 s limit (the configured name is used otherwise).
  - Needs: nothing beyond sign-in (`User.Read`); unchecked during a live sign-in.
- **Arming with a new session id** (S-08)
  - Expected live: Entra arming sets a new `__Host-adminforge` cookie and the old one answers 401; other tabs' live
    updates reconnect with the new cookie; `tests/live/scripts/verify-api-live.ts` disarms after arming through its
    CSRF retry. Unchecked against the validation tenant.
- **Quoted Resource Graph lookups** (whole-branch content review S3, `azure.resource` 1.4.1,
  `azure.role-assignments` 1.1.1)
  - Request: the resource id, scope and role name go into the queries as `$kql()` literals, double-quoted and
    escaped (`| where tolower(id) == "<id>"`, `scope == "<scope>" or scope startswith "<scope>/"`,
    `roleName contains "<name>"`), instead of single-quoted with every character outside `[A-Za-z0-9._()/-]` stripped.
  - Needs: Reader on the subscription, as before.
  - Live: not run; run both pages once, read-only — ideally on a resource group whose name has non-ASCII letters.
