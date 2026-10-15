# Operations runbook

How to run AdminForge on its host day to day: services, health, backups, upgrades, secret rotation and certificates.
Installation is in `portal/deploy/README.md`; the security model is in `SECURITY.md`; error codes are in
`docs/troubleshooting.md`.

## What runs where

| Unit (`systemctl --user …`) | What it does                                                      | Listens on        |
| --------------------------- | ----------------------------------------------------------------- | ----------------- |
| `adminforge-proxy`          | Caddy: TLS for the LAN (`tls internal`)                           | `*:8443`          |
| `adminforge-api`            | Web app + API (sessions, delegated calls, content)                | `127.0.0.1:3300`  |
| `adminforge-worker`         | Playbook runs (pg-boss queue)                                     | —                 |
| `adminforge-scheduler`      | Schedules, probes, KQL checks, reports (one leader via a PG lock) | —                 |
| `adminforge-runner`         | PowerShell runner (Exchange, Teams, SharePoint)                   | `127.0.0.1:3101`  |
| Docker `adminforge-dev`     | Postgres 18 (both databases)                                      | `127.0.0.1:55432` |

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
pnpm adminforge validate && pnpm adminforge test
ADMINFORGE_ENV_OVERLAY=host pnpm adminforge publish     # the services pick it up within seconds (NOTIFY)
```

If a change adds `requires.scopes`, run `pnpm adminforge validate --scopes` and `pnpm adminforge provision entra`.
Publishing a new version of a playbook that a write-capable schedule runs switches that schedule off at its next run
until a second person approves it again (by design).

## Upgrade

```sh
git pull
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @adminforge/api db:migrate                               # dev database
ADMINFORGE_ENV_OVERLAY=host pnpm --filter @adminforge/api db:migrate   # services' database
ADMINFORGE_ENV_OVERLAY=host pnpm adminforge publish
pnpm adminforge validate --scopes     # if permissions changed: pnpm adminforge provision entra
pnpm --filter @adminforge/runner modules:install   # only if portal/apps/runner/modules.lock.json changed
systemctl --user restart adminforge-api adminforge-worker adminforge-scheduler adminforge-runner
```

Migrations only add; they are safe to apply before restarting the old processes.

## Database roles

The services don't connect as the database owner. `portal/deploy/db/create-app-role.sh` creates `adminforge_app`
(no superuser, no DDL; row access on every table; **insert/select only on `audit_events`**, so a compromised service
can't rewrite the audit log or drop its triggers) and rewrites the host overlay: `DATABASE_URL` → `adminforge_app`,
`DATABASE_MIGRATION_URL` → the owner (used only by `db:migrate`). The run queue (pg-boss) installs and partitions its own tables, so `adminforge_app` owns the `pgboss` schema and everything in it (and nothing in `public`). Tables added by later migrations get the same row access through default privileges; a migration that adds another append-only table must `REVOKE UPDATE, DELETE,
TRUNCATE` on it from `adminforge_app` itself.

```sh
portal/deploy/db/create-app-role.sh ~/.config/adminforge/dev.host.env            # once (idempotent)
portal/deploy/db/create-app-role.sh ~/.config/adminforge/dev.host.env --rotate   # new password
systemctl --user restart adminforge-api adminforge-worker adminforge-scheduler
```

## Backup and restore

`adminforge-backup.timer` runs `portal/deploy/backup/adminforge-backup.sh` daily at 02:30 (and catches up after
downtime). Each backup is a folder in `~/adminforge-backups/<UTC timestamp>/` (mode 700) holding:

- `adminforge.dump` — the services' database (`pg_dump -Fc`), checked to contain the audit table;
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
`AF_BACKUP_DATABASE`). Install it with:

```sh
sed "s#%h/AdminForge#$PWD#g" portal/deploy/systemd/adminforge-backup.service > ~/.config/systemd/user/adminforge-backup.service
cp portal/deploy/systemd/adminforge-backup.timer ~/.config/systemd/user/
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
- [ ] Branch protection on `main` with code-owner review (`.github/CODEOWNERS`); CI green.
- [ ] `WRITE_AUTH_CONTEXT` set if you have Entra ID P1 (Conditional Access step-up), otherwise `auth_time` step-up.
- [ ] Delivery configured if wanted: `AF_MAIL_SENDER`, Teams webhooks, `AF_APPROVALS_*`. Let the automation identity
      send **only as that mailbox**: leave Entra `Mail.Send` withheld (it can send as any mailbox, and Exchange
      permissions add to it rather than narrowing it) and assign Exchange RBAC for Applications instead —
      `New-ServicePrincipal -AppId <automation app id> -ObjectId <its service principal id>`,
      `New-ManagementScope -Name AdminForgeSender -RecipientRestrictionFilter "PrimarySmtpAddress -eq '<sender>'"`,
      `New-ManagementRoleAssignment -App <automation app id> -Role "Application Mail.Send" -CustomResourceScope
AdminForgeSender`. (Granting Entra `Mail.Send` needs `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true`.)
- [ ] Backups: timer enabled, encrypted to an off-host key (`AF_BACKUP_GPG_RECIPIENT`), copied off the host, restore
      drill recorded above.
- [ ] Services connect as `adminforge_app` (`portal/deploy/db/create-app-role.sh`), not the database owner.
- [ ] `AF_PROTECTED_APP_IDS` lists the provisioner's client id (AdminForge's own playbooks then refuse to touch it).
- [ ] Monitoring page green (portal readiness, audit chain, token probes); licence gaps reviewed
      (`docs/licensing-review.md`).
- [ ] Run as a dedicated system user with system units for filesystem isolation (recommended; `SECURITY.md`).

## Secret and key rotation

| Secret                                   | How                                                                                                                                                                                                                                                                                                                                          | Effect                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Provisioner client secret                | Create a new secret on the provisioner app in Entra, put it in `<env>.admin.env`, delete the old one in Entra. **Do this now if it was ever shared** (for example in a chat).                                                                                                                                                                | None on the services                                        |
| Read / Write / Automation client secrets | Valid 180 days. `provision entra` creates a new one only when the stored one is missing or expired: to rotate early, empty the key (`AF_READ_CLIENT_SECRET=`), run `pnpm adminforge provision entra`, restart api/worker/scheduler, then delete the old credential in Entra. The `probes.app-credential-expiry` probe warns ahead of expiry. | Brief restart                                               |
| `TOKEN_CACHE_KEY`                        | `openssl rand -base64 32`, update `<env>.env`, restart api/worker                                                                                                                                                                                                                                                                            | Everyone signs in again; pending show-once secrets are lost |
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
valid 10 years) and renews them itself. Clients trust the root once:

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
wrap them in `pnpm adminforge provision test-identities --enable` / `--disable`.

```sh
PUBLIC_BASE_URL=https://<lan-address>:8443 AF_LIVE_INSECURE_TLS=1 \
NODE_EXTRA_CA_CERTS=~/.local/share/caddy/pki/authorities/local/root.crt pnpm test:live
```
