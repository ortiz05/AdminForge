# Running AdminForge on this host

Everything needed to run AdminForge as services on one Linux host: systemd user units, the local Postgres, the
least-privilege database role, backups and the LAN proxy.

| Path                          | What                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `defaults.env`                | Deploy constants: Postgres container name, owner role, database, port ([below](#deploy-defaults))   |
| `lib/defaults.sh`             | Loads `defaults.env` into the shell scripts (environment values win; only `AF_PG_*` keys allowed)   |
| `docker-compose.dev.yml`      | The Postgres container (`pnpm db:up` / `pnpm db:down`)                                              |
| `install-units.sh`            | Installs the systemd user units, pointed at this checkout                                           |
| `systemd/`                    | Unit templates (`%h/AdminForge` = the checkout) and `hardening.conf`, every unit's drop-in          |
| `db/create-app-role.sh`       | The services' least-privilege database role (`adminforge_app`) and their two URLs                   |
| `db/harden-postgres.sh`       | `pnpm db:harden`: non-superuser owners, the app role's limits, PUBLIC closed, superuser socket-only |
| `db/compose.sh`               | `pnpm db:up` / `db:down`: compose with defaults.env, your env file and its owner file               |
| `db/initdb/`                  | New clusters: the superuser may not sign in over TCP (also applied by `db:harden`)                  |
| `db/app-role-grants.sql`      | The grants that role gets (applied by the script and by `tests/api/app-role-pg.test.ts`)            |
| `backup/adminforge-backup.sh` | Daily backup (run by `adminforge-backup.timer`)                                                     |
| `caddy/Caddyfile.example`     | TLS reverse proxy for LAN access                                                                    |

Conventions: shell scripts are bash with `set -euo pipefail` and a header saying what they do, what they read and what
they print (names and sizes, never values or secrets); every script has a test under `tests/unit/deploy/` that runs it
against fakes (`docker`, `openssl`, a scratch unit directory), never against the real database or `~/.config`.

AdminForge runs as four Node processes next to PostgreSQL (R5, R6):

| Process       | What it does                                                                                     | Entry                                    |
| ------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| **api**       | The BFF: sign-in, every `/api` route, serves the built web app                                   | `portal/apps/api` → `dist/main.js`       |
| **worker**    | Executes playbook and runbook runs from the queue                                                | `portal/apps/api` → `dist/worker.js`     |
| **scheduler** | Runs content schedules (probe sweeps, KQL checks, reports, playbooks) as the automation identity | `portal/apps/scheduler` → `dist/main.js` |
| **runner**    | PowerShell runner on loopback (Exchange, Teams, SharePoint)                                      | `portal/apps/runner` → `dist/main.js`    |

Configuration lives outside the repository in `~/.config/adminforge/` (mode 700, files mode 600), in layers
(`portal/packages/config`; `config/example.env` documents every key):

| File             | Read by                                      | Holds                                                                     |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| `dev.env`        | api, worker, scheduler, CLI, `pnpm dev`      | Runtime settings and secrets (`ADMINFORGE_ENV=<name>` picks another file) |
| `dev.host.env`   | the services (`ADMINFORGE_ENV_OVERLAY=host`) | Their own `DATABASE_URL`, so `pnpm dev` never shares their run queue      |
| `dev.admin.env`  | CLI and live tests only                      | Provisioner and live-test credentials                                     |
| `dev.runner.env` | runner only (`EnvironmentFile=`)             | `RUNNER_SHARED_KEY`                                                       |

On a host that also runs `pnpm dev`, keep the two apart: the services use the `adminforge` database (its URL in
`dev.host.env`), and `dev.env` points at a second one, `adminforge_dev`, owned by its own role (`pnpm db:harden`
creates both). Migrate both
(`pnpm --filter @adminforge/api db:migrate`, then the same with `ADMINFORGE_ENV_OVERLAY=host`) and publish content to
the services' database with `ADMINFORGE_ENV_OVERLAY=host pnpm adminforge publish`.

## Database

```sh
pnpm db:up                                   # Postgres 18 in Docker on 127.0.0.1:55432 (docker-compose.dev.yml)
pnpm db:harden --dry-run && pnpm db:harden   # roles and limits (docs/operations.md → Postgres hardening)
pnpm --filter @adminforge/api db:migrate     # tables, including schedules / schedule_runs / probe_results
pnpm db:down                                 # stop it (the data stays in the adminforge-dev_pgdata volume)
```

`pnpm db:up` (`db/compose.sh`) passes `defaults.env`, then your env file (`ADMINFORGE_ENV_FILE`, default
`~/.config/adminforge/dev.env`) and, when it exists, its owner file (`dev.owner.env`, which holds `POSTGRES_PASSWORD`
from `init:local` — compose reads it only when it creates a new cluster). Run compose through those scripts: on its own
it refuses to start without the defaults.

### Deploy defaults

`defaults.env` is the one place for the local Postgres's names and port:

| Key                  | Default                     | Used by                                                                                      |
| -------------------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| `AF_PG_CONTAINER`    | `adminforge-dev-postgres-1` | `docker exec` in the backup and app-role scripts (compose derives the name from its project) |
| `AF_PG_USER`         | `adminforge`                | The superuser compose creates (socket only); `pg_dump -U` in the backup, `docker exec psql`  |
| `AF_PG_DATABASE`     | `adminforge`                | The services' database compose creates; the one the backup dumps                             |
| `AF_PG_OWNER`        | `adminforge_owner`          | Owns the services' database and runs its migrations (`db:harden`)                            |
| `AF_PG_DEV_USER`     | `adminforge_dev`            | Owns the dev and test databases (`pnpm dev`, the DB tests)                                   |
| `AF_PG_DEV_DATABASE` | `adminforge_dev`            | The development database                                                                     |
| `AF_PG_PORT`         | `55432`                     | The loopback port compose publishes                                                          |

Any of them can be overridden from the environment (or, for compose, your env file). `config/example.env`'s
`DATABASE_URL`, `init:local` and the docs can't read the file; `tests/unit/deploy/deploy-defaults.test.ts` fails when
they disagree with it, so change them in the same commit.

### The services' database role

The host services connect as `adminforge_app` (row access only, no DDL, insert/select only on the audit log); migrations
use the owner through `DATABASE_MIGRATION_URL` in the owner file (`dev.host.owner.env`). Create it, or rotate its password, against the services' env
file — the script prints key names only, never values:

```sh
portal/deploy/db/create-app-role.sh                                  # ~/.config/adminforge/dev.host.env
portal/deploy/db/create-app-role.sh ~/.config/adminforge/dev.host.env --rotate
systemctl --user restart adminforge-api adminforge-worker adminforge-scheduler
```

It reads the owner from the owner file's `DATABASE_MIGRATION_URL` (else the env file's, else `DATABASE_URL`), runs SQL
in `AF_DB_CONTAINER` (else `AF_PG_CONTAINER`) as the container's superuser over its socket with passwords on stdin,
applies `db/app-role-grants.sql`, and writes `DATABASE_URL` to the env file and `DATABASE_MIGRATION_URL` to the owner
file. Then run `pnpm db:harden` (limits, ownership, `pg_hba`).

### Backups

`adminforge-backup.timer` runs `backup/adminforge-backup.sh` daily at 02:30: a `pg_dump` of the services' database
(without the rows of the credential tables `sessions`, `preauth` and `token_cache`), the services' configuration (never
`*.admin.env`, never the database owner's credentials) and report/Caddy data, into `~/adminforge-backups/<UTC
timestamp>/` (mode 700, files 600), encrypted to an off-host GPG key — it refuses to run without one unless
`AF_BACKUP_ALLOW_PLAINTEXT=1`. Install it with `portal/deploy/install-units.sh backup`, then
`systemctl --user enable --now adminforge-backup.timer`. Settings (`AF_BACKUP_*`), encryption, restore and the restore
drill: [docs/operations.md](../../docs/operations.md#backup-and-restore).

## Build

```sh
pnpm install
pnpm build          # turbo: api, worker, scheduler, runner, web
```

## Run as user services (systemd)

The units in `systemd/` are **user** units: they run as you, without root, and read your env file. `install-units.sh`
copies them to `~/.config/systemd/user`, replacing `%h/AdminForge` with this checkout's path, and adds `hardening.conf`
(the sandboxing user units enforce; see its comments) as each unit's drop-in. It is idempotent — it writes a file only
when it changed and prints `installed` / `updated` / `unchanged` per file — leaves your own drop-ins (`override.conf`)
alone, and never reloads or restarts anything; it prints the commands for that.

```sh
portal/deploy/install-units.sh --dry-run    # what would change
portal/deploy/install-units.sh              # api worker scheduler runner (add proxy / backup by name)
systemctl --user daemon-reload
systemctl --user enable --now adminforge-api adminforge-worker adminforge-scheduler adminforge-runner
loginctl enable-linger "$USER"      # keep them running when you are not logged in
```

Re-run it after pulling changes to `systemd/` (or after moving the checkout: `--checkout <dir>`; the path may only
contain letters, digits and `. _ / + -`, because it is written into `ExecStart=`), then
`systemctl --user daemon-reload` and restart the units it updated.

### Running as a dedicated service account (recommended)

User units run as your login account, and on this host that account is in the `docker`, `sudo`, `lxd` and `adm`
groups — any process running as it can `docker exec` into Postgres as the superuser and rewrite the audit log
(`SECURITY.md`, Postgres finding C1). `install-service-account.sh` moves the services to two system accounts in none of
those groups: `adminforge` (api, worker, scheduler) and `adminforge-runner` (the PowerShell runner, which gets only its
own env file and can't see the API's configuration or state). Postgres stays in Docker and the services keep connecting
over TCP as `adminforge_app`. It runs as root, so read the script and its dry run first — and never allow it through a
`NOPASSWD` sudoers rule (whoever can edit the checkout could then run code as root):

```sh
portal/deploy/install-service-account.sh --firewall           # dry run: the whole plan, nothing changes, no root
sudo portal/deploy/install-service-account.sh --apply --firewall
```

`--apply` creates the accounts (`nologin`) and copies:

- node and PowerShell out of your home to `/opt/adminforge/runtime`;
- a read-only release of this checkout (committed and built; no `.git`, tests, docs, env files or keys) to
  `/opt/adminforge/releases/<sha>.<time>`, with `current` pointing at it;
- the configuration to `/etc/adminforge` — only keys documented in `config/example.env`, never provisioner,
  test-account or database-owner keys or a `*.admin.env` / `*.owner.env` file; keys the overlay replaces (the owner's
  `DATABASE_URL`) are left out; the runner's file keeps its `RUNNER_*` settings only and is read by systemd, not by
  the runner's account. A certificate named by `AF_AUTOMATION_CERT_PATH` in your home is copied next to it; other
  path settings that point into a home directory are refused;
- the report files, once, to `/var/lib/adminforge/artifacts`;
- sandboxed system units (`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, no capabilities, `StateDirectory`
  the only writable path, no Docker socket, only the API and the runner may listen).

The plan names every key it leaves out and every user-unit setting it doesn't carry into
`adminforge-<unit>.service.d/10-carried.conf`; values are never printed. `--firewall` adds an nftables rule so that, on
loopback, the accounts reach only Postgres, the runner, the API, the proxy and the DNS stub. Make it survive a reboot
by including `/etc/adminforge/loopback.nft` from `/etc/nftables.conf`. Nothing starts: the script prints the
switch-over, a verification checklist and the rollback. The proxy (Caddy) and the backup stay your user units — the
backup needs Docker, and reads the report files through the `adminforge` group (log out and in once after `--apply`).

Later deploys, after `git pull`, `pnpm install --frozen-lockfile` and `pnpm build` (and migrations and publish) as you,
run the root-owned copy from the current release, never the one in your checkout:

```sh
sudo /opt/adminforge/current/portal/deploy/install-service-account.sh --release --checkout ~/Azure-Admin
sudo /opt/adminforge/current/portal/deploy/install-service-account.sh --rollback      # bad release: the previous one
sudo /opt/adminforge/current/portal/deploy/install-service-account.sh --sync-config --checkout ~/Azure-Admin
```

The configuration stays in `~/.config/adminforge`: edit it there, then `--sync-config` copies it to `/etc/adminforge`
and restarts the services (`--release` does too). The newest three releases are kept. To go back to user units (they
run whatever is built in your checkout, so build the commit you want first):

```sh
sudo systemctl disable --now adminforge-runner adminforge-api adminforge-worker adminforge-scheduler
sudo rsync -a /var/lib/adminforge/artifacts/ ~/.local/share/adminforge/artifacts/
sudo chown -R "$USER": ~/.local/share/adminforge/artifacts
systemctl --user enable --now adminforge-runner adminforge-api adminforge-worker adminforge-scheduler
sudo rm -rf /etc/adminforge
```

### Production overrides (this host)

The dev server (`pnpm dev`) uses `PUBLIC_BASE_URL`/`API_PORT` from the env file. The services run the production
build on their own origin; give them a drop-in so both can coexist (and add that origin to
`AF_REDIRECT_BASE_URLS`, then `pnpm adminforge provision entra`, so Entra accepts its redirects):

```ini
# ~/.config/systemd/user/adminforge-{api,worker,scheduler}.service.d/override.conf
[Service]
Environment=PATH=<node bin dir>:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
Environment=API_PORT=3300
Environment=PUBLIC_BASE_URL=http://localhost:3300
Environment=CONTENT_SOURCE=db
Environment=RUN_WORKER_IN_PROCESS=false
Environment=SCHEDULER_IN_PROCESS=false
Environment=ADMINFORGE_ENV_OVERLAY=host
# api only: listen on loopback (the default since 0.1.0; Caddy publishes it — see LAN access)
Environment=API_HOST=127.0.0.1
```

Production reads definitions from Postgres: run `ADMINFORGE_ENV_OVERLAY=host pnpm adminforge publish` after content
changes (CI does not publish).
`http://localhost` works because browsers treat it as a secure context; any other host name needs TLS in front
(see below), because the session cookie is `__Host-` and `Secure` and Entra only accepts `http://` redirect URIs for
`localhost`.

### LAN access (TLS with Caddy, no root)

Caddy terminates TLS on an unprivileged port with its own local CA and proxies to the API, which then listens on
loopback only. Replace `ADDRESS` with the host's LAN IP or DNS name:

```sh
# Caddy: latest release binary from github.com/caddyserver/caddy/releases (verify its sha512) → ~/.local/bin/caddy
sed 's/ADDRESS/<lan-ip-or-name>/' portal/deploy/caddy/Caddyfile.example > ~/.config/adminforge/Caddyfile
portal/deploy/install-units.sh proxy
systemctl --user daemon-reload && systemctl --user enable --now adminforge-proxy
```

Then point the services at the new origin and register it with Entra:

```ini
# adminforge-{api,worker,scheduler} override.conf
Environment=PUBLIC_BASE_URL=https://<lan-ip-or-name>:8443
Environment=NODE_EXTRA_CA_CERTS=%h/.local/share/caddy/pki/authorities/local/root.crt
# adminforge-api override.conf only: loopback-only listener; TRUST_PROXY defaults to loopback (Caddy on this host)
Environment=API_HOST=127.0.0.1
```

```sh
# env file: AF_REDIRECT_BASE_URLS=...,https://<lan-ip-or-name>:8443
pnpm adminforge provision entra
systemctl --user restart adminforge-api adminforge-worker adminforge-scheduler
```

Browsers on other machines must trust Caddy's root certificate
(`~/.local/share/caddy/pki/authorities/local/root.crt`, valid 10 years; Caddy renews the short-lived server certificate
itself): import it as a trusted root (Windows: `certutil -addstore -user Root root.crt`; macOS: Keychain Access →
System → Always Trust). With a DNS name and a certificate from your own CA, replace `tls internal` with that
certificate. Sign-in works on the public origin only, so use the LAN URL on this host too. If the address is
DHCP-assigned, reserve it (or use a DNS name), since the certificate and the Entra redirect URIs name it.
Live validation through the proxy: `PUBLIC_BASE_URL=https://… AF_LIVE_INSECURE_TLS=1` (see `tests/live`).

If `node` comes from nvm or fnm, add its `bin` directory to the `Environment=PATH=…` line in a drop-in
(`systemctl --user edit adminforge-scheduler`), not in the installed unit: `install-units.sh` would overwrite that.

Logs and status:

```sh
systemctl --user status adminforge-scheduler
journalctl --user -u adminforge-scheduler -f
```

`systemctl --user stop adminforge-scheduler` sends SIGTERM: running jobs get 30 seconds to finish, anything still
running is recorded as interrupted, and the scheduler lock is released.

## The scheduler

- **One active scheduler.** Each scheduler process campaigns for a Postgres advisory lock; the holder fires
  schedules, the others stand by and take over within seconds if the leader stops or loses its database
  connection. Starting the unit on a second host (or twice) gives a hot standby, never double runs.
- **Identity.** Jobs run as the automation identity (`AF_AUTOMATION_CLIENT_ID` + `AF_AUTOMATION_CERT_PATH` or
  `AF_AUTOMATION_CLIENT_SECRET`) in read mode. Playbook jobs are handed to the run worker; write-capable schedules
  only run after a second person approved enabling them. Every run is a `schedule_runs` row and an audit event
  "scheduled by X, executed as automation identity".
- **Content.** Schedules come from `portal/content/schedules` and are synced into the `schedules` table. New
  schedules start disabled unless their YAML says `enabled: true` and they cannot change data.
- **Report files** go to `ADMINFORGE_ARTIFACTS_DIR` (default `~/.local/share/adminforge/artifacts`) as
  `<schedule>/<timestamp>.<ext>` and are downloadable from the Schedules page.
- **Concurrency.** `SCHEDULER_CONCURRENCY` jobs at a time (default 4).

One-shot commands (from `portal/apps/scheduler`, no leadership needed; they print statuses and codes, never tenant
data):

```sh
node dist/main.js --once                       # run every probe once and print its status
node dist/main.js --probe probes.token-graph   # run named probes once
node dist/main.js --schedule sweep.hourly      # run one schedule now (audited as a manual run)
```

Add `--no-store` to skip writing results to the database.

For development, the API can host the scheduler instead of a separate process: set `SCHEDULER_IN_PROCESS=true`
(leader election still applies, so a separately running scheduler and the API never both fire).
