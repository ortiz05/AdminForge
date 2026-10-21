# AdminForge on Kubernetes

AdminForge runs as **one pod** (ADR-017) and keeps all of its state in **one SQLite file on a PersistentVolume**
(ADR-016).

```
            Ingress (TLS, PUBLIC_BASE_URL)
                       │
                Service adminforge :80
                       │
┌──────────────────────┴───────────────────────────────────────────────┐
│ Pod adminforge  (Deployment: replicas 1, strategy Recreate)          │
│                                                                      │
│  api       :3300  API + run worker + scheduler, one Node process     │
│            │      the only writer of /var/lib/adminforge/adminforge.db│
│            └──► 127.0.0.1:3101  runner (PowerShell sidecar)          │
│                                                                      │
│  /var/lib/adminforge ◄── PVC adminforge-data (ReadWriteOncePod, disk)│
└──────────────────────────────────────────────────────────────────────┘
```

| Path                    | What                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `Dockerfile`            | The app image: API, built web app, `adminforge` CLI, content (runner: `portal/apps/runner/Dockerfile`) |
| `build-images.sh`       | Builds both images tagged with the commit; records whether the content was reviewed                    |
| `base/`                 | Deployment, PVC, Service, ServiceAccount, NetworkPolicy, ConfigMap (kustomize)                         |
| `overlays/example/`     | An installation to copy: namespace, images, Ingress, storage class, TRUST_PROXY                        |
| `tools/loader-pod.yaml` | A one-off pod to put a database file on the volume (or take one off)                                   |

## Requirements

- Kubernetes **1.29+** (ReadWriteOncePod). AKS works as is.
- A **block storage** class: a disk attached to the node — AKS `managed-csi` (Azure Disk). **Never** Azure Files, NFS
  or a FUSE mount (blobfuse): SQLite's locking is unreliable on network filesystems and corrupts the database. The API
  refuses to start on one.
- An ingress controller with TLS that passes Server-Sent Events through unbuffered (the example uses ingress-nginx).
- A **network policy engine** that enforces the NetworkPolicy (AKS: Azure Network Policy Manager, Cilium or Calico).
  Without one, any pod in the cluster can reach the API directly and set `X-Forwarded-For` — forging the client
  address that rate limits and the audit log use. Set `TRUST_PROXY` (overlay) to the ingress controller's pods'
  addresses as narrowly as your network allows.
- A container registry the cluster can pull from.
- Egress on 443 to Microsoft (Graph, Azure Resource Manager, Log Analytics, `login.microsoftonline.com`, Exchange /
  Teams / SharePoint for the runner, the first-party news feeds).

What this design does not do, by design: more than one replica, autoscaling, rolling updates without downtime. About
50 engineers at once is well within one pod. A deploy restarts the pod — a short outage, seconds to a minute.

## 1. Build and push the images

```bash
git fetch origin
portal/deploy/kubernetes/build-images.sh --registry registry.example.com/adminforge --push
```

Both images are built from the `HEAD` commit itself (`git archive`: uncommitted, untracked and git-ignored files are
never in them) and tagged with it. The app image records in `/app/BUILD.json` whether that commit is merged to
`origin/main` (as last fetched) — the review rule `adminforge publish` enforces; publishing from an image of any other
commit needs `--allow-unreviewed`, which the audit log records. Pin the pushed digests in your overlay.

## 2. Secrets

The pod gets its configuration as environment variables — nothing is read from files in the image.

**`adminforge-env`** — the installation's settings: the env file you would use on a workstation, **without** the
admin-only keys (they stay in `<env>.admin.env` on the operator's machine: provisioner and test-user credentials
never reach the cluster).

```bash
kubectl create namespace adminforge
kubectl -n adminforge create secret generic adminforge-env --from-env-file="$HOME/.config/adminforge/prod.env"
```

It must hold at least `PUBLIC_BASE_URL` (the Ingress URL), `AUTH_MODE=entra`, `AF_TENANT_ID`, the Read/Write app
settings, `TOKEN_CACHE_KEY`, `RUNNER_SHARED_KEY` and, for schedules, the automation identity — `adminforge env check
--for portal,schedules` on the file tells you what is missing. The pod's layout (`DATABASE_PATH`, `API_HOST`, ports,
`NODE_ENV`, `CONTENT_SOURCE`) comes from the ConfigMap and wins over the Secret, so a copied env file can't move the
database off the volume. Keys of the Postgres releases (`DATABASE_URL`, `*_IN_PROCESS`, …) are ignored; `env check`
lists them so you can drop them.

The runner gets **only** `RUNNER_SHARED_KEY` from this Secret (never the rest).

**`adminforge-automation-cert`** (optional) — when the automation identity uses a certificate:

```bash
kubectl -n adminforge create secret generic adminforge-automation-cert --from-file=automation.pem=./automation.pem
```

and set `AF_AUTOMATION_CERT_PATH=/etc/adminforge/automation/automation.pem` in your overlay's ConfigMap (the commented
line in `overlays/example/kustomization.yaml`) — not in the env file, whose own `AF_AUTOMATION_CERT_PATH` is the
certificate's path on your workstation, where `adminforge provision` reads it.

**`adminforge-tls`** — the Ingress certificate (cert-manager, or `kubectl create secret tls`).

Changing a Secret takes effect at the next restart: `kubectl -n adminforge rollout restart deploy/adminforge`.

Entra: the Read and Write apps need the Ingress URL as a redirect URI — set `PUBLIC_BASE_URL` (or add it to
`AF_REDIRECT_BASE_URLS`) in your workstation env file and run `pnpm adminforge provision entra --dry-run`, then without
`--dry-run`.

## 3. Deploy

```bash
cp -r portal/deploy/kubernetes/overlays/example ~/adminforge-cluster   # or a private repository of your own
# edit: images, host name, storage class, the ingress controller's namespace and pod network (TRUST_PROXY)
kubectl apply -k ~/adminforge-cluster
kubectl -n adminforge rollout status deploy/adminforge
```

The API creates the database file (mode 0600) and applies the migrations before it listens — the startup probe allows
for that. `GET /readyz` answers `{"status":"ok","checks":{"db":"ok","worker":"ok","scheduler":"ok"}}` once the run
worker and the scheduler have reported in.

## 4. Publish content

Content ships in the image; publishing makes the new versions live (runs pin a version):

```bash
kubectl -n adminforge exec deploy/adminforge -c api -- adminforge publish --dry-run
kubectl -n adminforge exec deploy/adminforge -c api -- adminforge publish
```

`publish` runs the same checks as `validate` and `test`, writes new versions in one transaction and tells the running
API (the `definitions_changed` signal) — no restart.

## 5. Upgrade

1. Build and push new images (step 1).
2. Take a backup or a volume snapshot (§ Backups) when the release changes the schema (`portal/apps/api/drizzle`).
3. Put the new tags or digests in the overlay and `kubectl apply -k` it. `Recreate` stops the old pod (running
   playbook steps get 10 s to reach a checkpoint; unfinished jobs are queued again), then the new pod migrates and
   starts.
4. Publish the content of the new image (step 4).

## Moving the data from the Postgres host (once)

The Postgres releases kept state in Postgres on the host. `adminforge db import-postgres` copies it — settings,
preferences, saved views, definitions, schedules and their grants, runs with steps and events, approvals, schedule
history, probe results, News and changes, and the audit log with its hash chain (re-verified; its tail must equal
Postgres') — into a new SQLite file. Signed-in sessions are not copied: everyone signs in again.

On the old host, from a checkout of this release:

```bash
# Stop writes first, so nothing happens after the copy's snapshot:
systemctl --user stop adminforge-api adminforge-worker adminforge-scheduler
# The services' database: the host overlay's DATABASE_URL (the URL is read from the env files, never typed).
ADMINFORGE_ENV_OVERLAY=host pnpm adminforge db import-postgres --dry-run
ADMINFORGE_ENV_OVERLAY=host pnpm adminforge db import-postgres --to ~/adminforge-import/adminforge.db
```

Then put the file on the volume with the loader pod (the Deployment scaled to 0 — instructions in
`tools/loader-pod.yaml`), and scale back to 1. Use the **same `TOKEN_CACHE_KEY`** in `adminforge-env`: schedules that run
with their creator's access keep their sealed grant tokens. Keep the old host's last `pg_dump` until you are satisfied.

## Backups

The database holds history (audit log, runs, approvals, schedules, settings); the Secret holds the keys
(`TOKEN_CACHE_KEY`, app secrets). Back up both, separately.

- **Volume snapshots** (primary): schedule CSI VolumeSnapshots of `adminforge-data` (AKS: Azure Disk snapshots, e.g.
  with Velero or Azure Backup for AKS). A snapshot is crash-consistent, and SQLite's write-ahead log is built to
  recover from exactly that. Restore = a new PVC from the snapshot.
- **Logical copies**: `adminforge db backup` makes a consistent copy (SQLite's online backup) without credential rows
  (sessions, sign-in round trips, the token cache), checks it (integrity, audit chain) and writes it mode 600. It is not
  encrypted: stream it out and encrypt it on your machine, with a key whose private half is not in the cluster:

  ```bash
  kubectl -n adminforge exec deploy/adminforge -c api -- adminforge db backup - \
    | gpg --encrypt --recipient <key> > "adminforge-$(date -u +%Y%m%dT%H%M%SZ).db.gpg"
  ```

  Restore: decrypt, then the loader pod (as in the data move). After a restore from a logical copy everyone signs in
  again, and creators re-consent schedules that run with their access.

## Audit log

The audit log is append-only in the database (triggers) and hash-chained. The triggers stop the application rewriting
history; they don't stop someone with write access to the volume (SQLite has no roles — ADR-016). What detects that
is the chain and its **checkpoints**: the API logs `audit chain checkpoint` lines (the audit-chain probe and the Audit
page). Forward the container logs off the cluster (Container Insights / Log Analytics, or your log store) and compare
them with:

```bash
kubectl -n adminforge exec deploy/adminforge -c api -- adminforge audit verify
```

## Operating

| Task                          | Command                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| Logs                          | `kubectl -n adminforge logs deploy/adminforge -c api` (`-c runner`)                                     |
| Probes once                   | `kubectl -n adminforge exec deploy/adminforge -c api -- node portal/apps/scheduler/dist/main.js --once` |
| Run one schedule now          | `… -- node portal/apps/scheduler/dist/main.js --schedule <key>` (or "Run now" in the portal)            |
| Configuration check           | `… -- adminforge env check --for portal,schedules` (names and states only)                              |
| Sign everyone out (emergency) | `… -- adminforge db sign-out-everyone --yes` (audited; docs/operations.md → Emergency)                  |
| Restart                       | `kubectl -n adminforge rollout restart deploy/adminforge`                                               |

## Troubleshooting

| Symptom                                                                  | Cause and fix                                                                                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pod `Pending`: volume node affinity / multi-attach                       | The disk is zonal and the pod was scheduled elsewhere, or the old pod still holds it. Wait for the old pod to end; pin the zone in the overlay.                                 |
| `The database in DATABASE_PATH is not safe to use: … network filesystem` | The storage class is Azure Files/NFS/FUSE. Use a disk class (`managed-csi`) and move the data (loader pod).                                                                     |
| `… can be read or written by other users` / `owned by another user`      | The file's mode or owner changed (copied in as another user). With the loader pod, copy it off, delete it and copy it back in (it then belongs to the API's user), `chmod 600`. |
| `/readyz` says `degraded` (`worker` or `scheduler` not `ok`)             | The process is up but a background loop isn't reporting (look for errors in the log). A restart recovers; report it if it recurs.                                               |
| `The database is busy (another process is writing)` from the CLI         | A long write in the API (retention, a large publish) held the lock past `DATABASE_BUSY_TIMEOUT_MS`. Run the command again.                                                      |
| Sign-in loops or `invalid_state`                                         | `PUBLIC_BASE_URL` differs from the Ingress URL, or the apps lack it as a redirect URI (`provision entra`).                                                                      |
| Run streams or the event dock never update                               | The ingress buffers Server-Sent Events: `proxy-buffering: off` and a long read timeout (overlay `ingress.yaml`).                                                                |
