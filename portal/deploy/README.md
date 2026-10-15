# Running AdminForge on this host

AdminForge runs as four Node processes next to PostgreSQL (R5, R6):

| Process       | What it does                                                                                     | Entry                                    |
| ------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| **api**       | The BFF: sign-in, every `/api` route, serves the built web app                                   | `portal/apps/api` → `dist/main.js`       |
| **worker**    | Executes playbook and runbook runs from the queue (`ROLE=worker`)                                | `portal/apps/api` → `dist/worker.js`     |
| **scheduler** | Runs content schedules (probe sweeps, KQL checks, reports, playbooks) as the automation identity | `portal/apps/scheduler` → `dist/main.js` |
| **runner**    | PowerShell runner on loopback (Exchange, Teams, SharePoint)                                      | `portal/apps/runner` → `dist/main.js`    |

Every process reads its configuration from `~/.config/adminforge/dev.env` (choose another file with
`ADMINFORGE_ENV=<name>` or `ADMINFORGE_ENV_FILE=<path>`). Nothing tenant-specific lives in the repository;
`config/example.env` documents every key.

## Database

```sh
pnpm db:up                                   # dev Postgres (portal/deploy/docker-compose.dev.yml)
pnpm --filter @adminforge/api db:migrate     # tables, including schedules / schedule_runs / probe_results
```

## Build

```sh
pnpm install
pnpm build          # turbo: api, worker, scheduler, runner, web
```

## Run as user services (systemd)

The units in `systemd/` are **user** units: they run as you, without root, and read your env file.

```sh
mkdir -p ~/.config/systemd/user
for u in api worker scheduler runner; do   # + proxy for LAN access, below
  sed "s#%h/AdminForge#$PWD#g" portal/deploy/systemd/adminforge-$u.service > ~/.config/systemd/user/adminforge-$u.service
done
systemctl --user daemon-reload
systemctl --user enable --now adminforge-api adminforge-worker adminforge-scheduler adminforge-runner
loginctl enable-linger "$USER"      # keep them running when you are not logged in
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
```

Production reads definitions from Postgres: run `pnpm adminforge publish` after content changes (CI does this on merge).
`http://localhost` works because browsers treat it as a secure context; any other host name needs TLS in front
(see below), because the session cookie is `__Host-` and `Secure` and Entra only accepts `http://` redirect URIs for
`localhost`.

### LAN access (TLS with Caddy, no root)

Caddy terminates TLS on an unprivileged port with its own local CA and proxies to the API, which then listens on
loopback only. Replace `ADDRESS` with the host's LAN IP or DNS name:

```sh
# Caddy: latest release binary from github.com/caddyserver/caddy/releases (verify its sha512) → ~/.local/bin/caddy
sed 's/ADDRESS/<lan-ip-or-name>/' portal/deploy/caddy/Caddyfile.example > ~/.config/adminforge/Caddyfile
cp portal/deploy/systemd/adminforge-proxy.service ~/.config/systemd/user/
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

Run the `sed` from the repository root (it points `WorkingDirectory` at your checkout). If `node` comes from
nvm or fnm, add its `bin` directory to the `Environment=PATH=…` line (`systemctl --user edit adminforge-scheduler`).

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
