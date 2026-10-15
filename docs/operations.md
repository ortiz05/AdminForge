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

## Backup and restore

Back up the database **and** the files it depends on:

```sh
B=~/adminforge-backups/$(date +%F); install -d -m 700 "$B"
docker exec adminforge-dev-postgres-1 pg_dump -U adminforge -Fc adminforge > "$B/adminforge.dump"
tar -C ~/.config -czf "$B/config.tgz" adminforge                       # env files incl. TOKEN_CACHE_KEY
tar -C ~/.local/share -czf "$B/data.tgz" adminforge caddy              # report files, Caddy's CA
chmod -R go-rwx "$B"
```

Keep backups encrypted and access-controlled: they contain client secrets and the token-cache key. Without
`TOKEN_CACHE_KEY` the sealed token cache can't be read (everyone signs in again; nothing else is lost).

Restore: stop the services, `pg_restore -U adminforge -d adminforge --clean` the dump into the container (pipe it
through `docker exec -i`), put the config and data archives back, start the services. The audit chain verifies after
a restore of a consistent dump.

## Secret and key rotation

| Secret                                   | How                                                                                                                                                                                                                                                                                                                                          | Effect                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Provisioner client secret                | Create a new secret on the provisioner app in Entra, put it in `<env>.admin.env`, delete the old one in Entra. **Do this now if it was ever shared** (for example in a chat).                                                                                                                                                                | None on the services                                        |
| Read / Write / Automation client secrets | Valid 180 days. `provision entra` creates a new one only when the stored one is missing or expired: to rotate early, empty the key (`AF_READ_CLIENT_SECRET=`), run `pnpm adminforge provision entra`, restart api/worker/scheduler, then delete the old credential in Entra. The `probes.app-credential-expiry` probe warns ahead of expiry. | Brief restart                                               |
| `TOKEN_CACHE_KEY`                        | `openssl rand -base64 32`, update `<env>.env`, restart api/worker                                                                                                                                                                                                                                                                            | Everyone signs in again; pending show-once secrets are lost |
| `RUNNER_SHARED_KEY`                      | New value in both `<env>.env` and `<env>.runner.env`, restart runner, api and worker together                                                                                                                                                                                                                                                | Runner calls fail until all three restarted                 |
| `POSTGRES_PASSWORD`                      | `ALTER ROLE adminforge PASSWORD …` in the container, update `POSTGRES_PASSWORD` and both `DATABASE_URL`s, restart                                                                                                                                                                                                                            | Brief restart                                               |
| Live-test user password / TOTP seed      | `pnpm adminforge provision test-identities` (password); re-run `tests/live/scripts/register-test-user-mfa.ts` (TOTP)                                                                                                                                                                                                                         | Test tenants only                                           |

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
reversible writes on `AF-Test-*` objects only:

```sh
PUBLIC_BASE_URL=https://<lan-address>:8443 AF_LIVE_INSECURE_TLS=1 \
NODE_EXTRA_CA_CERTS=~/.local/share/caddy/pki/authorities/local/root.crt pnpm test:live
```
