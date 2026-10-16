# Operations runbook

How to run AdminForge on its host day to day: services, health, backups, upgrades, secret rotation and certificates.
Installation is in `portal/deploy/README.md`; the security model is in `SECURITY.md`; error codes are in
`docs/troubleshooting.md`.

## What runs where

| Unit (`systemctl --user …`) | What it does                                                                              | Listens on        |
| --------------------------- | ----------------------------------------------------------------------------------------- | ----------------- |
| `adminforge-proxy`          | Caddy: TLS for the LAN (`tls internal`)                                                   | `*:8443`          |
| `adminforge-api`            | Web app + API (sessions, delegated calls, content)                                        | `127.0.0.1:3300`  |
| `adminforge-worker`         | Playbook runs (pg-boss queue)                                                             | —                 |
| `adminforge-scheduler`      | Schedules, probes, KQL checks, reports, News and changes feeds (one leader via a PG lock) | —                 |
| `adminforge-runner`         | PowerShell runner (Exchange, Teams, SharePoint)                                           | `127.0.0.1:3101`  |
| Docker `adminforge-dev`     | Postgres 18 (both databases)                                                              | `127.0.0.1:55432` |

Configuration (all mode 600 in `~/.config/adminforge/`, mode 700):

| File               | Read by                           | Holds                                                                     |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------- |
| `<env>.env`        | Everything (`ADMINFORGE_ENV=dev`) | Runtime settings, app client ids/secrets, `TOKEN_CACHE_KEY`, dev DB URL   |
| `<env>.host.env`   | api, worker, scheduler            | Overlay (`ADMINFORGE_ENV_OVERLAY=host`): the services' own `DATABASE_URL` |
| `<env>.admin.env`  | CLI and live tests only           | Provisioner credentials, live-test user                                   |
| `<env>.runner.env` | runner only                       | `RUNNER_SHARED_KEY`                                                       |
| `Caddyfile`        | proxy                             | The LAN address                                                           |

The services use the `adminforge` database; `pnpm dev` uses `adminforge_dev`. Commands that should act on the
services' database take the overlay: `ADMINFORGE_ENV_OVERLAY=host pnpm adminforge publish`.

## Start, stop, status

```sh
U="adminforge-proxy adminforge-api adminforge-worker adminforge-scheduler adminforge-runner"
systemctl --user status $U --no-pager | grep -E "●|Active"
systemctl --user restart $U          # after a build or a config change
systemctl --user stop $U             # scheduler: running jobs get 30 s, then are recorded as interrupted
journalctl --user -u adminforge-api -f            # logs (JSON); filter by a Reference:  | grep <reference>
curl -s --cacert ~/.local/share/caddy/pki/authorities/local/root.crt https://<lan-address>:8443/readyz
```

`/healthz` answers when the process is up; `/readyz` also checks the database. Linger is on, so the services run
without anyone logged in (`loginctl enable-linger "$USER"`).

## Content changes

Content in `portal/content` is served from the database in production. After merging content:

```sh
git fetch && git checkout main && git pull --ff-only
ADMINFORGE_ENV_OVERLAY=host pnpm adminforge publish     # the services pick it up within seconds (NOTIFY)
```

`publish` runs the same checks as `validate` and the playbook tests and refuses on errors. It also refuses content
that isn't reviewed: uncommitted changes under `portal/content`, a checkout that isn't a git repository, or a commit
that isn't on `origin/main` as last fetched (it never fetches). `--dry-run` says what would be refused. For an
emergency fix, `--allow-unreviewed` publishes anyway and records the reasons in the `content.published` audit event —
follow it with the reviewed change. (This is a process check on a local ref; branch protection on the repository is
what makes review mandatory.)

If a change adds `requires.scopes`, run `pnpm adminforge validate --scopes` and `pnpm adminforge provision entra`.
Publishing a new version of a playbook that a write-capable schedule runs switches that schedule off at its next run
until a second person approves it again (by design).

## Report schedules created in the portal

Operators can schedule reports from Reports → a report → **Schedule** (report jobs only, at most hourly, delivered to
the recipient lists and Teams webhooks configured in the env file). Unlike content schedules they live **only in the
database** (`schedules` rows with `source = 'portal'`, keys `portal.<report>-<hex>`): `adminforge publish` never
creates, changes or removes them, and the daily backup (the database dump) is what keeps them — a restore brings them
back with their history.

- **Find them:** Schedules (the "Created in portal" badge and the creator), the report's details in Reports, or the
  database:

  ```sql
  select key, enabled, definition->>'owner' as owner, next_run_at from schedules
  where source = 'portal' and coalesce(definition->>'status', 'active') <> 'retired';
  ```

- **Turn one off:** any `Portal.Operator` uses its switch (audited `schedule.disabled`). Its creator or a
  `Portal.Admin` can edit or delete it (`schedule.updated` / `schedule.deleted`). Deleting keeps the row (retired)
  and its run history and files until retention; housekeeping then removes the row (once no run history is left, and
  at least a day after it was created).
- **Creator check:** before every run the scheduler confirms, as the automation identity, that the creator is still an
  enabled member holding `Portal.Operator` and the report's roles (cached 10 minutes). When someone leaves or loses a
  role, their schedules stop at their next run (`creator_access_removed`) and are turned off — audited as
  `schedule.disabled` by the automation identity, with the reason. If the check can't read Entra, runs fail with
  `creator_unverified` and the schedules stay on: check that the automation identity has **User.Read.All**,
  **GroupMember.Read.All** and **Application.Read.All** (`pnpm adminforge provision status`) and that
  `AF_READ_CLIENT_ID` is set in the scheduler's configuration. With mock sign-in there is nothing to check.
- **Who created what:** the Audit page, actions `schedule.created`, `schedule.updated`, `schedule.deleted`.
- **Emergency stop** applies to them like any schedule: while automation is paused nothing fires; they can still be
  created and turned off.
- New recipient lists and webhooks: add an `AF_…_RECIPIENTS` / `AF_…_WEBHOOK` key to the env file and restart the api
  and scheduler; the schedule form offers configured keys only (email also needs `AF_MAIL_SENDER`). The approval keys
  (`AF_APPROVALS_EMAIL`, `AF_APPROVALS_TEAMS_WEBHOOK`) are never offered.

## News and changes

The hourly schedule `maintenance.news-refresh-hourly` (five past every hour, UTC) collects the feeds in
`portal/content/feeds` (`docs/news.md`). Each feed is collected at most every `pollMinutes`, so most runs touch only
the hourly feeds; the `/news` page's Sources control shows each feed's last success and status.

```sh
# collect now (prints one line per feed with its status and code — never item text)
ADMINFORGE_ENV_OVERLAY=host node portal/apps/scheduler/dist/main.js --schedule maintenance.news-refresh-hourly
```

The host needs outbound https to the feed hosts (www.microsoft.com, api.msrc.microsoft.com,
techcommunity.microsoft.com, www.powershellgallery.com, learn.microsoft.com, developer.microsoft.com) besides Graph and
Azure Resource Manager. The tenant feeds need the automation app's ServiceMessage.Read.All and ServiceHealth.Read.All
(`pnpm adminforge provision entra`) and Reader on the subscriptions. Feed failures and their codes are listed in
`docs/news.md`.

## Upgrade

```sh
git pull
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @adminforge/api db:migrate                               # dev database
ADMINFORGE_ENV_OVERLAY=host pnpm --filter @adminforge/api db:migrate   # services' database
ADMINFORGE_ENV_OVERLAY=host pnpm adminforge publish                     # needs a clean checkout of origin/main
pnpm adminforge validate --scopes     # if permissions changed: pnpm adminforge provision entra
pnpm --filter @adminforge/runner modules:install   # only if portal/apps/runner/modules.lock.json changed
systemctl --user restart adminforge-api adminforge-worker adminforge-scheduler adminforge-runner
```

Migrations only add; they are safe to apply before restarting the old processes. Deploy from a checkout of a reviewed
commit (ideally a tag, in a directory the services can't write to), not from a working copy someone is editing: the
units run `dist/` from their `WorkingDirectory`, so anything built there goes live at the next restart.

Runner workers start with `portal/apps/runner/ps/powershell.config.json` (PowerShell's own script-block and module
logging off). If the journal grew before that, reclaim it with `journalctl --user --vacuum-size=…`. Installed
Caddyfiles made from an older example should add `header -Via` at site level (`header_down -Via` has no effect).

## Database roles

The services don't connect as the database owner. `portal/deploy/db/create-app-role.sh` creates `adminforge_app`
(no superuser, no DDL; row access on every table; **insert/select only on `audit_events`**, so a compromised service
can't rewrite the audit log or drop its triggers) and rewrites the host overlay: `DATABASE_URL` → `adminforge_app`,
`DATABASE_MIGRATION_URL` → the owner (used only by `db:migrate`). The run queue (pg-boss) installs and partitions its own tables, so `adminforge_app` owns the `pgboss` schema and everything in it (and nothing in `public`). Tables added by later migrations get the same row access through default privileges; a migration that adds another append-only table must `REVOKE UPDATE, DELETE,
TRUNCATE` on it from `adminforge_app` itself.

The services' configuration loader drops `DATABASE_MIGRATION_URL` and `POSTGRES_PASSWORD`; only `db:migrate` asks
for them. Two more steps make the owner credential less useful to a compromised process: make the owner a
**non-superuser** role (create one with `CREATEROLE` and ownership of the database, and keep the container's superuser
for maintenance), and refuse the owner and superuser over TCP except from where you run migrations (`pg_hba.conf`).

```sh
portal/deploy/db/create-app-role.sh ~/.config/adminforge/dev.host.env            # once (idempotent)
portal/deploy/db/create-app-role.sh ~/.config/adminforge/dev.host.env --rotate   # new password
systemctl --user restart adminforge-api adminforge-worker adminforge-scheduler
```

## Backup and restore

`adminforge-backup.timer` runs `portal/deploy/backup/adminforge-backup.sh` daily at 02:30 (and catches up after
downtime). Each backup is a folder in `~/adminforge-backups/<UTC timestamp>/` (mode 700) holding:

- `adminforge.dump` — the services' database (`pg_dump -Fc`), checked to contain the audit table. The rows of
  `sessions`, `preauth` and `token_cache` are left out (their tables are kept), so a copied backup holds no sign-ins
  or refresh tokens and a restore signs everyone out;
- `config.tgz` — the services' configuration in `~/.config/adminforge` (env files incl. client secrets and
  `TOKEN_CACHE_KEY`). **Never included:** `<env>.admin.env` (provisioner and validation-user credentials — re-issue
  them instead of restoring them) and stray copies (`*.bak*`);
- `data.tgz` — report files and Caddy's data. Caddy's private keys (local CA and site certificate) are included only
  when the backup is encrypted; otherwise a restore issues a new local CA and browsers must trust it again.

**Encryption:** set `AF_BACKUP_GPG_RECIPIENT` (in the backup unit's environment) to a GPG key whose **private key is not
on this host** — e.g. the platform owner's key, imported with `gpg --import owner.pub` and trusted. Every file is then
written as `*.gpg` and the plaintext is shredded; restore with `gpg --decrypt` on a machine that holds the private
key. Unencrypted backups still hold the services' client secrets and `TOKEN_CACHE_KEY`.

Folders older than 14 days are deleted (`AF_BACKUP_KEEP_DAYS`; also `AF_BACKUP_DIR`, `AF_BACKUP_PG_CONTAINER`,
`AF_BACKUP_DATABASE`; the container, user, database and port default to `portal/deploy/defaults.env`). Install it with:

```sh
portal/deploy/install-units.sh --dry-run backup   # shows what would change
portal/deploy/install-units.sh backup             # unit, timer and hardening drop-in; never restarts anything
systemctl --user daemon-reload && systemctl --user enable --now adminforge-backup.timer
systemctl --user start adminforge-backup     # one now; journalctl --user -u adminforge-backup for the result
```

Copy backups off the host (they are the only copy otherwise) and keep them encrypted and access-controlled: they hold
the services' client secrets and the token-cache key. Without `TOKEN_CACHE_KEY` the sealed token cache can't be read (everyone signs
in again; nothing else is lost).

**Restore:** stop the api, worker and scheduler; restore the dump
(`docker exec -i adminforge-dev-postgres-1 pg_restore -U adminforge -d adminforge --clean --no-owner < adminforge.dump`);
put `config.tgz` and `data.tgz` back; start the services; run `ADMINFORGE_ENV_OVERLAY=host pnpm adminforge audit verify`.

**Restore drill** — do one after every upgrade that adds a migration, and at least quarterly: restore the newest dump
into a scratch database (`createdb adminforge_restore_drill`, `pg_restore … -d adminforge_restore_drill`), compare row
counts of `audit_events`, `runs`, `schedules`, `definitions` with the live database, run `adminforge audit verify`
against it (point `DATABASE_URL` at the scratch database), then drop it. Record it here.

| Date       | Backup               | Result                                                                                              |
| ---------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| 2026-10-15 | 2026-10-15T08-41-14Z | Restored; counts matched (625 audit events, 93 runs, 16 schedules, 194 definitions); chain verified |

## Emergency: switch AdminForge off

If AdminForge or an account using it may be compromised, stop it from acting before investigating:

0. **Pause from the portal** (fastest, no shell needed): Admin → Settings → Emergency stop → pause **changes** and/or
   **automation**, with a reason. A `Playbook.Approver` or `Portal.Admin` can pause; only a `Portal.Admin` resumes.
   Every write (interactive, scheduled, PowerShell) is refused and no schedule fires; reads and AdminForge's
   notification mail keep working. This doesn't help if the host or the services' configuration is compromised — then
   continue with the steps below.
1. **Disable the enterprise apps** in Entra (Enterprise applications → AdminForge Read / Write / Automation `[<label>]`
   → Properties → _Enabled for users to sign in?_ = No). Sign-ins and token refreshes stop within minutes; Write first
   if time is short.
2. **Stop unattended work:** `systemctl --user stop adminforge-scheduler adminforge-worker`.
3. **Revoke sessions:** `systemctl --user stop adminforge-api`, then (if needed)
   `docker exec adminforge-dev-postgres-1 psql -U adminforge -d adminforge -c 'truncate sessions, token_cache'`.
4. **Rotate secrets** (table below), starting with the automation and Write app secrets and the provisioner.
5. **Investigate** with the audit log (`adminforge audit verify`, then the Audit page or `audit_events` by
   `correlation_id`/actor) and the Entra sign-in and audit logs. Re-enable in reverse order.

## Disaster recovery (new host)

1. Install the prerequisites (README), clone the repository at the deployed commit, `pnpm install --frozen-lockfile`,
   `pnpm build`.
2. Restore `config.tgz` to `~/.config/adminforge` and `data.tgz` to `~/.local/share`; start Postgres (`pnpm db:up`)
   and restore the dump as above; then run `portal/deploy/db/create-app-role.sh` (the role lives in the Postgres
   cluster, not in the dump). Re-issue the provisioner credential (`<env>.admin.env` is never backed up).
3. Install the units (portal/deploy/README.md) and start them. If the host name or address changed, update the
   Caddyfile, `PUBLIC_BASE_URL` overrides and `AF_REDIRECT_BASE_URLS`, then `pnpm adminforge provision entra`.
4. Check: `/readyz` is `ok`, `adminforge audit verify` passes, the live suite passes (`tests/live/README.md`).

## Go-live checklist

- [ ] Provisioner secret rotated (it was shared during setup) and stored only in `<env>.admin.env`.
- [ ] People added to the `SG-AdminForge-<label>-*` groups (`docs/access.md`); the validation test user removed or
      disabled outside test tenants.
- [ ] TLS: a DNS name and a certificate from your CA (or Caddy's root trusted on every client); address reserved.
- [ ] Branch protection on `main` with code-owner review by a **second person** (`.github/CODEOWNERS` lists more than
      one owner for content and security-sensitive paths); CI green; the services run a reviewed commit.
- [ ] `WRITE_AUTH_CONTEXT` set if you have Entra ID P1 (Conditional Access step-up). Without it, arming proves only a
      fresh sign-in, not MFA (Admin → Settings shows "Fresh sign-in only"; `adminforge env check` warns).
- [ ] `AF_PROTECTED_USER_IDS` lists your break-glass / emergency-access accounts (object ids), so nothing in AdminForge
      can change them; the automation identity holds Application.Read.All so the protected set can be read.
- [ ] Alerts go somewhere: `AF_SCHEDULE_ALERTS` and/or `AF_TEAMS_ALERTS_WEBHOOK` set, and the probe sweep schedules
      notify on failure — otherwise a failing scheduler, backup or audit-chain check is only visible on the
      Monitoring page.
- [ ] Delivery configured if wanted: `AF_MAIL_SENDER`, Teams webhooks, `AF_APPROVALS_*`. Let the automation identity
      send **only as that mailbox**: leave Entra `Mail.Send` withheld (it can send as any mailbox, and Exchange
      permissions add to it rather than narrowing it) and assign Exchange RBAC for Applications instead —
      `New-ServicePrincipal -AppId <automation app id> -ObjectId <its service principal id>`,
      `New-ManagementScope -Name AdminForgeSender -RecipientRestrictionFilter "PrimarySmtpAddress -eq '<sender>'"`,
      `New-ManagementRoleAssignment -App <automation app id> -Role "Application Mail.Send" -CustomResourceScope
AdminForgeSender`. (Granting Entra `Mail.Send` needs `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true`.) A tenant that
      has never been customised refuses `New-ManagementScope` ("you first need to run …
      Enable-OrganizationCustomization"): run `Enable-OrganizationCustomization` once, then retry the scope —
      it can keep refusing for hours after `Get-OrganizationConfig` already reports `IsDehydrated: False`. New
      role assignments take up to an hour or two to apply. Check it (prefix `ADMINFORGE_ENV_OVERLAY=host` for the
      services' configuration; only the sender itself is mailed): `pnpm exec tsx tests/live/scripts/check-mail-sender.ts --not-as "<another mailbox>"` — the
      sender's own message `sent`, sending as the other mailbox `refused`.
- [ ] Backups: timer enabled, encrypted to an off-host key (`AF_BACKUP_GPG_RECIPIENT`), copied off the host, restore
      drill recorded above.
- [ ] Services connect as `adminforge_app` (`portal/deploy/db/create-app-role.sh`), not the database owner.
- [ ] `AF_PROTECTED_APP_IDS` lists the provisioner's client id (AdminForge's own playbooks then refuse to touch it).
- [ ] Monitoring page green (portal readiness, audit chain, token probes); licence gaps reviewed
      (`docs/licensing-review.md`).
- [ ] Run under an account dedicated to AdminForge — no other network-facing services under it, and not in the
      `docker`, `sudo`, `lxd` or `adm` groups (docker group membership is root on the host). Best: a dedicated system
      user with system units (`SECURITY.md` → Host and network).

## Secret and key rotation

| Secret                                   | How                                                                                                                                                                                                                                                                                                                                          | Effect                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Provisioner client secret                | Create a new secret on the provisioner app in Entra, put it in `<env>.admin.env`, delete the old one in Entra. **Do this now if it was ever shared** (for example in a chat).                                                                                                                                                                | None on the services                                        |
| Read / Write / Automation client secrets | Valid 180 days. `provision entra` creates a new one only when the stored one is missing or expired: to rotate early, empty the key (`AF_READ_CLIENT_SECRET=`), run `pnpm adminforge provision entra`, restart api/worker/scheduler, then delete the old credential in Entra. The `probes.app-credential-expiry` probe warns ahead of expiry. | Brief restart                                               |
| `TOKEN_CACHE_KEY`                        | `openssl rand -base64 32`, update `<env>.env`, restart api/worker                                                                                                                                                                                                                                                                            | Everyone signs in again; pending show-once secrets are lost |
| Caddy local CA (if trusted by clients)   | Delete `~/.local/share/caddy/pki/authorities/local`, restart `adminforge-proxy`, distribute the new `root.crt`, **remove the old root from every client**                                                                                                                                                                                    | Browsers warn until the new root is trusted                 |
| `RUNNER_SHARED_KEY`                      | New value in both `<env>.env` and `<env>.runner.env`, restart runner, api and worker together                                                                                                                                                                                                                                                | Runner calls fail until all three restarted                 |
| `POSTGRES_PASSWORD`                      | `ALTER ROLE adminforge PASSWORD …` in the container, update `POSTGRES_PASSWORD` and both `DATABASE_URL`s, restart                                                                                                                                                                                                                            | Brief restart                                               |
| Live-test user password / TOTP seed      | `pnpm adminforge provision test-identities` (password); re-run `tests/live/scripts/register-test-user-mfa.ts` (TOTP)                                                                                                                                                                                                                         | Test tenants only                                           |

### The provisioner

The provisioner is the most powerful credential AdminForge uses, and it lives on this host in `<env>.admin.env`
(never read by the services, never backed up). Keep its power short-lived:

- Give it **Global Administrator only while provisioning**. For Azure role assignments use **Role Based Access
  Control Administrator** on the subscription, conditioned to assign only Reader and Log Analytics Reader — not Owner.
- Per run: create a client secret valid for one day, put it in `<env>.admin.env`, run `provision entra` /
  `test-identities` / `status`, then delete the secret in Entra and remove the directory role.
- `provision test-identities --enable/--disable` (and so `pnpm test:live`) changes a privileged user, which needs
  Global Administrator or Privileged Authentication Administrator at that moment.
- `AF_PROTECTED_APP_IDS` (runtime env) should list its client id, so AdminForge's own playbooks refuse to touch it.
- The opt-in licensed test fixtures (`AF_TEST_LICENCE_SKU`, `AF_TEST_FIXTURES`) need Microsoft Graph **application
  permissions** on it — its directory role doesn't cover those APIs app-only (`LicenseAssignment.ReadWrite.All`,
  `RoleEligibilitySchedule.ReadWrite.Directory`, `Policy.Read.All` + `Policy.ReadWrite.ConditionalAccess`,
  `DeviceManagementConfiguration.ReadWrite.All`; table in `tests/live/README.md`), and the Teams test objects need
  `Team.Create`. **Application permissions survive removing the directory role**, and PIM eligibility, Conditional
  Access and Intune configuration are tier-0: grant only the ones the run needs, and remove them when it's done.
  `provision status` shows a ⚠ listing any of them the provisioner's token still holds (it decodes the token; names
  only). To remove them:
  - Entra admin centre → **Enterprise applications** → the provisioner → **Permissions**: the granted application
    permissions are listed there (also under App registrations → API permissions → "Other permissions granted").
    Revoke each one (… → Revoke admin consent), then confirm with `provision status`.
  - Or with Microsoft Graph PowerShell, as an administrator:

    ```powershell
    Connect-MgGraph -Scopes 'AppRoleAssignment.ReadWrite.All','Application.Read.All'
    $sp = Get-MgServicePrincipal -Filter "appId eq '<provisioner client id>'"
    $graph = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
    $drop = 'LicenseAssignment.ReadWrite.All','RoleEligibilitySchedule.ReadWrite.Directory','Policy.Read.All',
            'Policy.ReadWrite.ConditionalAccess','DeviceManagementConfiguration.ReadWrite.All','Team.Create'
    Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id |
      Where-Object { $_.ResourceId -eq $graph.Id -and
        ($graph.AppRoles | Where-Object Id -eq $_.AppRoleId).Value -in $drop } |
      ForEach-Object { Remove-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -AppRoleAssignmentId $_.Id }
    ```

    Grant them again (admin consent) before the next fixtures run; until then those fixtures show `✗` with the
    permission each one needs.

### The automation identity on a certificate

```sh
cat cert.pem key.pem > ~/.config/adminforge/automation.pem && chmod 600 ~/.config/adminforge/automation.pem
# set AF_AUTOMATION_CERT_PATH in <env>.env, then:
pnpm adminforge provision entra --dry-run   # shows: register certificate, remove client secrets
pnpm adminforge provision entra && systemctl --user restart adminforge-api adminforge-worker adminforge-scheduler
pnpm adminforge provision status
```

### Permission opt-ins

`AF_ALLOW_PRIVILEGED_WRITE_SCOPES` (tier-0 delegated scopes on the Write app), `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS`
(application permissions that change data) and `AF_AUTOMATION_ALLOW_SENSITIVE_READS` (mail, files, sites, chats, …)
are deliberate decisions: set them in `<env>.admin.env`, review `provision entra --dry-run`, and record the decision in your change record (not in this repository: it's installation state). `provision status` fails on privilege that provisioning didn't grant.

## Certificates (LAN access)

Caddy issues short-lived server certificates from its own root (`~/.local/share/caddy/pki/authorities/local/root.crt`,
valid 10 years) and renews them itself. Its private key sits on this host and the root isn't name-constrained, so
whoever obtains it could issue a certificate for any site to every browser that trusts it. Prefer a certificate for a
DNS name from your own CA; if you trust Caddy's root, trust it only on admins' machines and treat its key like a
secret (rotate: delete `~/.local/share/caddy/pki/authorities/local`, restart the proxy, and remove the old root from
every client). Clients trust the root once:

- Windows: `certutil -addstore -user Root root.crt`
- macOS: Keychain Access → System → import → Always Trust
- Linux (Chrome/Edge): `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n AdminForge -i root.crt`
- Firefox: Settings → Certificates → Import, trust for websites

If the host's address changes, update `~/.config/adminforge/Caddyfile`, `PUBLIC_BASE_URL` in the api/worker/scheduler
overrides and `AF_REDIRECT_BASE_URLS`, run `pnpm adminforge provision entra`, and restart. Prefer a reserved address
or a DNS name with a certificate from your own CA.

## Giving people access

See `docs/access.md`. In short: add the person to `SG-AdminForge-<label>-Portal.Reader` (and `-Portal.Operator` to
make changes). Changes apply within 5 minutes, also for removals.

## Live validation

`tests/live/README.md`: the Playwright live suite signs in as the validation user and exercises reads, arming and
reversible writes on `AF-Test-*` objects only. The validation user is **disabled between runs**: `pnpm test:live`
enables it in its global setup and disables it (revoking sessions) afterwards; for the scripts in `tests/live/scripts`
wrap them in `pnpm adminforge provision test-identities --enable` / `--disable`. Live runs of the Exchange and
SharePoint write playbooks need `AF_TEST_SERVICE_ADMIN_ROLES=true` in `<env>.admin.env` before
`provision test-identities` (tenant-wide Exchange Recipient Administrator and SharePoint Administrator for the
validation user; default off, removed again when the key is off). Provisioning manages only the `af-…` account it
created and refuses any other account at `AF_TEST_USER_UPN`.

```sh
PUBLIC_BASE_URL=https://<lan-address>:8443 AF_LIVE_INSECURE_TLS=1 \
NODE_EXTRA_CA_CERTS=~/.local/share/caddy/pki/authorities/local/root.crt pnpm test:live
```
