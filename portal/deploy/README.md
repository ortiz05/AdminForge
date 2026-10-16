# Running AdminForge on this host

Everything needed to run AdminForge as services on one Linux host: systemd user units, the local Postgres, the
least-privilege database role, backups and the LAN proxy.

| Path                          | What                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `defaults.env`                | Deploy constants: Postgres container name, owner role, database, port ([below](#deploy-defaults)) |
| `lib/defaults.sh`             | Loads `defaults.env` into the shell scripts (environment values win; only `AF_PG_*` keys allowed) |
| `docker-compose.dev.yml`      | The Postgres container (`pnpm db:up` / `pnpm db:down`)                                            |
| `install-units.sh`            | Installs the systemd user units, pointed at this checkout                                         |
| `systemd/`                    | Unit templates (`%h/AdminForge` = the checkout) and `hardening.conf`, every unit's drop-in        |
| `db/create-app-role.sh`       | The services' least-privilege database role (`adminforge_app`) and their two URLs                 |
| `db/app-role-grants.sql`      | The grants that role gets (applied by the script and by `tests/api/app-role-pg.test.ts`)          |
| `backup/adminforge-backup.sh` | Daily backup (run by `adminforge-backup.timer`)                                                   |
| `caddy/Caddyfile.example`     | TLS reverse proxy for LAN access                                                                  |

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
`dev.host.env`), and `dev.env` points at a second one, `adminforge_dev`
(`docker exec adminforge-dev-postgres-1 createdb -U adminforge adminforge_dev`). Migrate both
(`pnpm --filter @adminforge/api db:migrate`, then the same with `ADMINFORGE_ENV_OVERLAY=host`) and publish content to
the services' database with `ADMINFORGE_ENV_OVERLAY=host pnpm adminforge publish`.

## Database

```sh
pnpm db:up                                   # Postgres 18 in Docker on 127.0.0.1:55432 (docker-compose.dev.yml)
pnpm --filter @adminforge/api db:migrate     # tables, including schedules / schedule_runs / probe_results
pnpm db:down                                 # stop it (the data stays in the adminforge-dev_pgdata volume)
```

`pnpm db:up` passes `defaults.env` and then your env file (`ADMINFORGE_ENV_FILE`, default `~/.config/adminforge/dev.env`,
which holds `POSTGRES_PASSWORD` from `init:local`) to compose. Run compose through those scripts: on its own it refuses
to start without the defaults.

### Deploy defaults

`defaults.env` is the one place for the local Postgres's names and port:

| Key               | Default                     | Used by                                                                                      |
| ----------------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| `AF_PG_CONTAINER` | `adminforge-dev-postgres-1` | `docker exec` in the backup and app-role scripts (compose derives the name from its project) |
| `AF_PG_USER`      | `adminforge`                | The owner role compose creates; `pg_dump -U` in the backup                                   |
| `AF_PG_DATABASE`  | `adminforge`                | The database compose creates; the one the backup dumps                                       |
| `AF_PG_PORT`      | `55432`                     | The loopback port compose publishes                                                          |

Any of them can be overridden from the environment (or, for compose, your env file). `config/example.env`'s
`DATABASE_URL`, `init:local` and the docs can't read the file; `tests/unit/deploy/deploy-defaults.test.ts` fails when
they disagree with it, so change them in the same commit.

### The services' database role

The host services connect as `adminforge_app` (row access only, no DDL, insert/select only on the audit log); migrations
keep using the owner through `DATABASE_MIGRATION_URL`. Create it, or rotate its password, against the services' env
file — the script prints key names only, never values:

```sh
portal/deploy/db/create-app-role.sh                                  # ~/.config/adminforge/dev.host.env
portal/deploy/db/create-app-role.sh ~/.config/adminforge/dev.host.env --rotate
systemctl --user restart adminforge-api adminforge-worker adminforge-scheduler
```

It reads the owner from `DATABASE_MIGRATION_URL` (else `DATABASE_URL`), runs SQL in `AF_DB_CONTAINER` (else
`AF_PG_CONTAINER`) with passwords on stdin, applies `db/app-role-grants.sql`, and rewrites the two URLs in place.

### Backups

`adminforge-backup.timer` runs `backup/adminforge-backup.sh` daily at 02:30: a `pg_dump` of the services' database
(without the rows of the credential tables `sessions`, `preauth` and `token_cache`), the services' configuration (never
`*.admin.env`) and report/Caddy data, into `~/adminforge-backups/<UTC timestamp>/` (mode 700, files 600), optionally
encrypted to an off-host GPG key. Install it with `portal/deploy/install-units.sh backup`, then
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
