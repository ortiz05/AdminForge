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
| `preflight.sh`          | Read-only check of a cluster against the requirements below (kubectl reads and one server dry run)     |
| `base/`                 | Deployment, PVC, Service, ServiceAccount, NetworkPolicy, ConfigMap (kustomize)                         |
| `overlays/example/`     | An installation to copy: namespace, images, Ingress, storage class, TRUST_PROXY, private egress        |
| `tools/loader-pod.yaml` | A one-off pod to put a database file on the volume (or take one off)                                   |

## Requirements

What the cluster must provide, for the people preparing it. `preflight.sh` checks the parts kubectl can see (read
only: `get`, `api-resources` and one server-side dry run of the database claim); the **cluster readiness checklist**
at the end of this section is the whole list. Where a number comes from is given with it: _measured_ numbers were
taken on 2026-10-21 on the interim host (the SQLite build, the validation tenant, one engineer, 54 enabled schedules
and 76 probes) or come from `docs/performance.md` (the 100k-user synthetic tenant, 50–200 engineers).

```bash
portal/deploy/kubernetes/preflight.sh --namespace adminforge --storage-class <class> [--pull-secret <name>]
```

What this design does not do, by design: more than one replica, autoscaling, rolling updates without downtime. About
50 engineers at once is well within one pod (`docs/operations.md` → Sizing for a large tenant).

### CPU architecture

**linux/amd64 only, today.** Both images' bases also exist for arm64; neither image has been built or tried there:

| Image                                    | Base (pinned by digest)                         | The base's platforms                                        | So                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| app (`Dockerfile`)                       | `node:26.11.1-bookworm-slim`                    | amd64, arm64/v8, ppc64le (a multi-platform index)           | better-sqlite3 13.0.3 ships prebuilt `linux-x64` and `linux-arm64` binaries (glibc ≥ 2.34; bookworm has 2.36) and the lockfile has the arm64 builds of the build tools (rollup, rolldown, lightningcss, Tailwind's oxide): it builds for arm64 as it is — not tried yet |
| runner (`portal/apps/runner/Dockerfile`) | `ubuntu:24.04` and the PowerShell 7.6.7 archive | amd64, arm64/v8 and four more; release archives: x64, arm64 | amd64: the Dockerfile installs the `linux-x64` archive and stops, saying so, on a machine of another architecture                                                                                                                                                       |

`build-images.sh` runs `docker build`, which builds for the platform of the machine it runs on: build on an amd64
machine. The Deployment selects `kubernetes.io/arch: amd64`, so on a cluster with arm64 nodes as well the pod only
lands on amd64 ones.

The runner's base is `ubuntu:24.04` pinned by digest, with the Ubuntu updates published by the day of the build
installed on top (`build-images.sh` passes the day, so a build cache doesn't keep older ones), and PowerShell 7.6.7 —
the 7.6 LTS line — from Microsoft's release archive, checked against the SHA-256 the release publishes before it is
unpacked (`tests/guards/runner-powershell-download.test.ts`). How it moves: Dependabot proposes each new
`ubuntu:24.04` digest (and Node tag) weekly; the PowerShell version is a reviewed bump of the version and hash in the
Dockerfile (`portal/apps/runner/README.md` → Container image). An image keeps the updates of the day it was built:
rebuilding and deploying it brings the ones published since.

What arm64 would take (size M, plus a test on arm64 hardware): the runner's Dockerfile choosing the `linux-arm64`
archive and its own SHA-256 (the same release's `hashes.sha256`) by `TARGETARCH`; a check that the five pinned
modules (`portal/apps/runner/modules.lock.json`) load under arm64 PowerShell (they are .NET modules; not checked);
`docker buildx build --platform linux/amd64,linux/arm64` in `build-images.sh` (emulated or on an arm64 builder) so
each tag is a multi-platform index — the app build already keeps the right better-sqlite3 binary per platform; then
drop the Deployment's `nodeSelector`, and run the runner's Pester suite and a live read-only job on arm64.

### Kubernetes

- **1.29 or later**: the database volume is `ReadWriteOncePod`, generally available from 1.29 (`base/pvc.yaml`). Use
  a minor version your distribution still supports.
- **The namespace enforces the `restricted` Pod Security Standard** (`pod-security.kubernetes.io/enforce: restricted`,
  `overlays/example/namespace.yaml`). Both containers and the loader pod meet it: fixed non-root uids (10001 api,
  10002 runner), no privilege escalation, `capabilities: drop: [ALL]`, RuntimeDefault seccomp, a read-only root file
  system.
- **Admission policies of your own** (Kyverno, Gatekeeper) must accept a pod **without CPU limits** — the API is one
  process with one busy thread, and a CPU limit throttles everyone's requests — and nothing may inject a sidecar into
  the pod (a service mesh: Istio's init container needs `NET_ADMIN`, which `restricted` refuses).
- **A ResourceQuota** on the namespace, if any, admits the pod's 750m CPU / 2 GiB requests and 5 GiB memory limits,
  and the loader pod's once in a while.
- **RBAC.** Whoever deploys creates the overlay's objects in the namespace. `pods/exec` into the pod is the
  operator's power — `publish`, `db backup`, `audit verify`, `db sign-out-everyone` — and whoever has it can read the
  database. Creating or changing pods or the Deployment in the namespace is as strong (a pod can mount the Secret and
  the volume), and changing NetworkPolicies can open the pod's egress. Grant these, and `get` on Secrets, only to the
  people who operate AdminForge. The pod itself never talks to the Kubernetes API (no service-account token).
- **Secrets encrypted at rest** (etcd encryption or a KMS provider): `adminforge-env` holds `TOKEN_CACHE_KEY`,
  `AUDIT_CHAIN_KEY` and the apps' credentials.

### Storage

- **A CSI block-storage class**: a disk attached to one node and formatted by the driver (ext4, xfs) — Azure Disk
  (`disk.csi.azure.com`), AWS EBS, vSphere CNS block volumes, Ceph RBD, Longhorn, OpenEBS or TopoLVM local volumes.
  **Never a network or FUSE file system** — NFS, SMB/CIFS (Azure Files), CephFS, GlusterFS, Lustre, blobfuse, S3 or
  GCS FUSE mounts: SQLite's locking is unreliable there and corrupts the database, and the API refuses to start on one
  (its `statfs` check knows NFS, SMB, FUSE, CephFS, GFS2, AFS, OCFS2 and Lustre:
  `portal/apps/api/src/db/file-check.ts:17`).
- **ReadWriteOncePod** needs a CSI driver (Kubernetes offers that access mode for CSI volumes only). A driver that
  refuses it shows when the first volume is provisioned (`kubectl describe pvc adminforge-data`); then patch the
  claim to `ReadWriteOnce` in the overlay — `replicas: 1` and `Recreate` still keep it to one pod.
- **fsGroup applied to the volume**: the CSIDriver's `fsGroupPolicy` is `File`, or the default
  `ReadWriteOnceWithFSType` on volumes that have a file system type — never `None`. The pod sets `fsGroup: 10001`;
  without it the API (uid 10001) can't create the database in the volume's root.
- **`volumeBindingMode: WaitForFirstConsumer`** for zonal or node-local disks (the volume is made where the pod is
  scheduled; afterwards the pod follows the volume — a node-local volume ties AdminForge to that node), and
  **`allowVolumeExpansion: true`**, so the claim can grow without a move.
- **Encryption at rest** by the storage: the database holds session hashes, sealed tokens and the audit history. The
  nodes' own disks too (AKS: encryption at host): `db backup -` stages a plaintext copy (without sessions and tokens,
  with runs and probe results) in the api's `/tmp`, on the node's ephemeral disk, while it runs.
- **Snapshots (optional)**: the CSI snapshot controller and a VolumeSnapshotClass for the driver, if you want
  scheduled snapshots (Velero or your backup tool). Logical copies (Backups) don't need them.

**Size: 10 GiB** (`base/pvc.yaml`) holds the database for years at the design target; what can outgrow it is report
files on a large tenant. Measured on the interim host's database (14.7 MB plus a 4 MB write-ahead log, six days of
history; bytes per row include the indexes), with the default retention (`config/example.env:258-262`):

| What                        | Measured                                                                   | Kept         | Settles at                                                                                              |
| --------------------------- | -------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| Probe results               | 3,372 a day (76 probes), ~310 B each                                       | 35 days      | ~37 MB here; a few hundred MB where many probes list findings (≤ 50 rows of ≤ 300-character cells each) |
| Schedule run history        | 260–330 a day (54 enabled schedules), ~2.2 KB each                         | 180 days     | ~115 MB                                                                                                 |
| Audit log                   | 280–380 events a day from schedules alone, ~850 B each                     | never purged | grows ~0.1 GB a year, plus each engineer's sign-ins, runs, exports, queries                             |
| Playbook runs               | ~15 KB a run with its steps and events (19 small runs; bulk runs are more) | 180 days     | e.g. 100 runs a day → ~0.27 GB                                                                          |
| Definitions                 | 765 versions, ~6 KB each                                                   | never purged | grows by each published change (MBs a year)                                                             |
| News and changes            | 755 items, 0.7 MB                                                          | per feed     | a few MB                                                                                                |
| Report files (`artifacts/`) | ~15 files a day, ≤ 40 KB each on the validation tenant                     | 90 days      | grows with the tenant: up to 100,000 rows a file (`EXPORT_MAX_ROWS`)                                    |

Probe and schedule volumes follow the number of schedules that are on, and a probe's findings are capped, so a large
tenant adds at most a few hundred MB there. So: 0.2–0.6 GB after the first half year, plus playbook runs and
~0.1–0.5 GB a year of audit log (depending on how busy people are) — and the report files: ~15 a day × 90 days, each
with as many rows as the tenant has items in that report. On a large tenant ask for **20 GiB** with expansion
allowed, and watch the volume (`kubelet_volume_stats_used_bytes`, or `kubectl exec … -- df -h /var/lib/adminforge`);
`RETENTION_ARTIFACT_DAYS` shortens the files' 90 days. Keep free space at least the database's size (a migration may
rebuild a table).

**Performance: low volume, latency-bound.** The schedules write a few thousand small rows a day, sessions are touched
at most once a minute each, heartbeats every 30 s — tens of commits a second at a busy moment, far below any SSD's
baseline IOPS. But every commit is flushed to disk before it returns (`synchronous = FULL`,
`portal/apps/api/src/db/client.ts:71`) and better-sqlite3 is synchronous: a slow flush holds the API's event loop, so
everyone waits on it. Use SSD-backed storage with single-digit-millisecond write latency; not HDD classes, and not
volumes replicated synchronously over a slow link (e.g. Longhorn replicas on distant nodes).

### Node size

| Container | Requests (`base/deployment.yaml`) | Limits                     | Measured                                                                                                                                                                                                                      |
| --------- | --------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api       | 500m CPU, 1 GiB                   | 2 GiB memory, no CPU limit | ~0.2 GB idle; 1.1–1.5 GB at 50–200 engineers, ~0.6 GB of it the load test's own copy of the tenant (`docs/performance.md`); about one core under load. A CLI run exec'd into it (`publish`, `validate`) peaks at 0.35–0.45 GB |
| runner    | 250m CPU, 1 GiB                   | 3 GiB memory               | supervisor 0.04–0.08 GB; each warm PowerShell worker (five modules loaded) 0.23 GB of its own plus 0.12 GB shared. Defaults `RUNNER_POOL_SIZE` 2 and `RUNNER_MAX_JOBS` 4 allow six workers: ~1.6 GB before the jobs' own data |
| **pod**   | **750m CPU, 2 GiB**               | **5 GiB memory**           |                                                                                                                                                                                                                               |

- **Ephemeral storage on the node**: the emptyDirs can hold up to 6.25 GiB (api `/tmp` 4 GiB, runner `/tmp` 2 GiB,
  runner home 256 MiB); one that passes its `sizeLimit` gets the pod evicted. The api's `/tmp` is that large because
  `adminforge db backup -` stages its copy of the database there (`portal/tools/cli/src/commands/db.ts:61`): past a
  4 GiB database, raise its `sizeLimit` in the overlay. Plus the container logs (the kubelet keeps 5 × 10 MiB per
  container by default) and the images (their bases alone are 79 MB and 139 MB compressed; the full images weren't
  built here — measure them with `docker image ls` after the first build).
- **Recommended**: amd64 nodes of **4 vCPU and 16 GB**, with at least **1 vCPU and 5 GiB of memory free** for this
  pod (so both containers can reach their limits without memory pressure on the node) and **~10 GB of free disk**.
  The smallest that works: 2 vCPU / 8 GB with little else on it. The pod has no anti-affinity or spreading needs —
  it is one pod.
- **A deploy is an outage (`Recreate`)**: the old pod stops first — measured 5 s on the interim host, at most the
  60 s grace period while playbook steps reach a checkpoint — then the disk moves if the new pod lands on another
  node (a detach and an attach, typically tens of seconds on cloud disks), the images are pulled if the node hasn't
  got them, and the API starts (measured 1.6 s to listening with no pending migration; migrations of a large
  database take longer, the startup probe allows 5 minutes). Expect well under a minute on the same node, one to two
  minutes when the disk moves. Pre-pulling the new images on the node shortens it.

### Ingress

- **An ingress controller (or Gateway) with TLS** and a DNS name engineers' browsers trust; `PUBLIC_BASE_URL` is that
  URL. The API sets HSTS, so the name must stay on HTTPS.
- **Server-Sent Events passed through unbuffered** (`/api/events`, the run streams): response buffering off and an
  idle read timeout well above 25 s — the API writes a `: ping` every 25 s on `/api/events` and every 15 s on a run
  stream (`portal/apps/api/src/routes/events.ts:8`, `portal/apps/api/src/runs/sse.ts:9`); the example uses 3600 s,
  so browsers don't reconnect every minute. No response compression that holds `text/event-stream` back.
- **Timeouts for other requests ≥ 300 s**: a page's datasource may take up to 120 s (`DATASOURCE_DEADLINE_MS`), the
  slow Microsoft reads one 120 s attempt, and report exports stream until they are done.
- **Request bodies ≥ 256 KiB**, the API's own limit (`portal/apps/api/src/app.ts:145`); the example allows 1 MiB.
- **The client's address**: the controller adds `X-Forwarded-For`, and `TRUST_PROXY` (overlay) names the controller
  pods' addresses — their pod network — as narrowly as your network allows; `true` is refused in production. Prefer
  a controller that doesn't use the host network: trusting the nodes' addresses makes every host-network pod and node
  agent a trusted proxy, and most network plugins let a node reach its pods whatever the policy says — any of them
  could forge the address the rate limits and the audit log use. When a load balancer in front of the controller
  translates source addresses, the controller sees the balancer's: keep the client's (`externalTrafficPolicy: Local`
  or the PROXY protocol), or every engineer shares one address in the rate limits and the audit log.
- **Only the controller may connect to the pod**: the overlay names its namespace in the NetworkPolicy's `from`.
- **From inside the pod, too**: the portal-readiness probe calls `PUBLIC_BASE_URL/readyz` through the Ingress, so the
  name must resolve in the cluster and the address be reachable from the pod (Network, below).
- The example's annotations are ingress-nginx's. **ingress-nginx is retired upstream** (no releases or security
  fixes since March 2026): on a new cluster prefer a maintained controller and give it the same settings.

### Network

- **A network policy engine that enforces NetworkPolicy**, egress and `ipBlock` `except` included (Calico, Cilium,
  Antrea, Azure NPM, …; plain flannel doesn't). Without one any pod in the cluster can reach the API directly and set
  `X-Forwarded-For`, forging the address rate limits and the audit log use — and the egress rules below do nothing.
- **DNS only to the cluster's resolver**: the policy allows UDP/TCP 53 to pods labelled `k8s-app: kube-dns` in
  `kube-system` (CoreDNS has that label on most distributions; elsewhere patch the rule). They must resolve public
  names and the Ingress's host name.
- **Direct HTTPS (TCP 443) to the hosts below**, best through a firewall that allows them by name (Azure Firewall
  application rules, Cilium `toFQDNs` or the like): plain NAT lets the pod reach any public address on 443, including
  services that trust the cluster's outbound address (PaaS firewalls, an API server with authorised IP ranges). **No
  HTTP proxy**: the API doesn't use `HTTPS_PROXY` (only the runner's PowerShell workers pass it on,
  `portal/apps/runner/src/config.ts:117`). **No TLS interception**: Node and .NET check Microsoft's certificates against
  the images' own trust stores. IPv4: the policy allows no IPv6 egress.
- **Private and reserved addresses are refused** by the base policy (10/8, 172.16/12, 192.168/16, 100.64/10, link-local
  with the cloud metadata service, Azure's WireServer, 0/8, 192.0.0/24, 198.18/15, 224/3). Name the private addresses
  you need — the Ingress for the portal-readiness probe, a Private Link endpoint — in
  `overlays/example/networkpolicy-private-egress.yaml`; through the ingress controller the pod reaches every site that
  controller serves, so keep internal-only sites on another controller. A network that uses other ranges internally
  (public addresses used privately) adds them to the base policy's `except` list with a patch in the overlay;
  `preflight.sh` compares the nodes' pod networks and addresses and the API server's Service address with the refused
  ranges.

| Host (TCP 443)                                                                                                                                              | What for                                                                                                                     | Where it comes from                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `login.microsoftonline.com`                                                                                                                                 | Sign-in, tokens for the Read, Write and automation apps; the Entra probes                                                    | MSAL (`portal/apps/api/src/auth/msal-client.ts`); `probes/entra-*.probe.yaml`                          |
| `graph.microsoft.com`                                                                                                                                       | Microsoft Graph: pages, playbooks, schedules, mail delivery, Message center and Service health; the runner's Graph and Teams | `portal/packages/connectors/src/graph.ts:106`; `portal/apps/api/src/auth/token-broker.ts:11`           |
| `management.azure.com`                                                                                                                                      | Azure Resource Manager, Resource Graph, Cost Management, Azure Service Health; the runner's Az                               | `portal/packages/connectors/src/arm.ts:32`                                                             |
| `api.loganalytics.io`                                                                                                                                       | Log Analytics (KQL checks, Query Studio)                                                                                     | `portal/packages/connectors/src/log-analytics.ts:37`                                                   |
| `outlook.office365.com`                                                                                                                                     | Exchange Online PowerShell (runner); the Outlook and Autodiscover probes                                                     | `token-broker.ts` (Exchange scope); `probes/exchange-*.probe.yaml`                                     |
| `api.interfaces.records.teams.microsoft.com`                                                                                                                | The MicrosoftTeams module's admin cmdlets (runner)                                                                           | the module, for the Teams admin API resource in `token-broker.ts` — not checked from a cluster         |
| `<AF_SPO_TENANT_NAME>-admin.sharepoint.com`, `<AF_SPO_TENANT_NAME>.sharepoint.com`                                                                          | PnP.PowerShell (runner); the SharePoint probe                                                                                | `portal/apps/runner/ps/AdminForge.Runner/Connections.ps1:122`; `probes/sharepoint-endpoint.probe.yaml` |
| `teams.cloud.microsoft`, `m365.cloud.microsoft`                                                                                                             | The Teams web and Microsoft 365 portal probes (redirects aren't followed)                                                    | `probes/teams-web-client.probe.yaml`, `probes/m365-web-portal.probe.yaml`                              |
| `www.microsoft.com`, `api.msrc.microsoft.com`, `techcommunity.microsoft.com`, `www.powershellgallery.com`, `learn.microsoft.com`, `developer.microsoft.com` | News and changes feeds (redirects only to these)                                                                             | `NEWS_FEED_HOSTS`, `portal/packages/schemas/src/news.ts:48`                                            |
| `*.logic.azure.com`, `*.environment.api.powerplatform.com`, `*.powerautomate.com`, `*.webhook.office.com`                                                   | Teams Workflows webhooks — only if `AF_…_WEBHOOK` keys are set                                                               | `portal/apps/api/src/delivery/notifier.ts:22`                                                          |
| Your Function App's host                                                                                                                                    | A `kind: connection` (e.g. `hr-sync`) — only if you use one                                                                  | its `baseUrl` in `portal/content/connections`                                                          |
| The Ingress (`PUBLIC_BASE_URL`)                                                                                                                             | The portal-readiness probe, from inside the pod                                                                              | `probes/portal-readiness.probe.yaml`                                                                   |

On a firewall that allows names, `*.sharepoint.com` and `*.teams.microsoft.com` cover the tenant-named and Teams
hosts. Nothing in the pod uses plain HTTP (port 80). Not checked from a cluster yet (the runner's modules may reach
further Microsoft hosts, e.g. PnP.PowerShell's update check and telemetry): look at the firewall's log after the
first live runner jobs and add what it refused.

The build machine (not the cluster) needs the npm registry, the PowerShell Gallery, Docker Hub and
`mcr.microsoft.com`, and the registry the cluster pulls from.

### Time

The nodes' clocks are kept in sync (NTP / chrony; containers use the node's clock). Arming write access and consenting
to a schedule accept a sign-in no older than 300 s by Entra's `auth_time` against the pod's clock
(`STEP_UP_MAX_AGE_SECONDS`, `portal/apps/api/src/auth/arm-routes.ts:28`) — a clock two minutes off turns that into
three or seven — and schedules fire, tokens expire and audit events are stamped by it. The runner refuses requests
signed more than ±60 s away (`RUNNER_MAX_CLOCK_SKEW_SECONDS`, `portal/apps/runner/src/client.ts:39`), but the api and
the runner share one node and its clock, so that window holds by construction.

### Registry and images

- **A container registry** the nodes can pull from, for two images per release (`adminforge`, `adminforge-runner`,
  tagged with the commit; § 1). Keep the previous release's images for a rollback. Nodes pull with their own identity
  (e.g. AKS attached to ACR) or an image pull secret in the namespace, named in the overlay:

  ```yaml
  patches:
    - target: { kind: Deployment, name: adminforge }
      patch: |-
        - op: add
          path: /spec/template/spec/imagePullSecrets
          value: [{ name: registry-pull }]
  ```

- **A build machine**: amd64, Docker with BuildKit (buildx), a checkout of a reviewed commit that can fetch from
  origin (§ 1).

### Secrets

`adminforge-env` (the installation's settings: tenant, apps, `TOKEN_CACHE_KEY`, `AUDIT_CHAIN_KEY` — recommended;
`env check` warns without it —, `RUNNER_SHARED_KEY`, `PUBLIC_BASE_URL`), `adminforge-tls` (the Ingress certificate, or
cert-manager) and, with a certificate-based automation identity, `adminforge-automation-cert` — made by an AdminForge
operator from the env file on their machine (§ 2), never from the admin-only file. The cluster's part: Secrets encrypted
at rest, `get` on them only for that operator (RBAC), and cert-manager if certificates should renew themselves.

### Logs

The api container's log (JSON lines on stdout) must be **shipped off the cluster** — a requirement, not an option — and
kept as long as the audit history must be provable: it carries the audit chain's checkpoints and cut-overs, the anchor
that shows a rewritten audit log (§ Audit log). Measured on the interim host: about 2 MB a day with nobody signed in
(schedules and probes; ~290 bytes a line). Each request and each Microsoft call adds a line, so 50 active engineers make
some hundreds of MB a day; the kubelet keeps only 5 × 10 MiB per container by default, so the shipper must keep up
continuously.

### Backups

- **Logical copies** need nothing from the cluster but `pods/exec`: `kubectl exec … adminforge db backup - | gpg …` on
  an operator's machine, kept off the cluster (§ Backups), with the api `/tmp` large enough for one copy (Node size).
  With `AUDIT_CHAIN_KEY` set, a copy verifies only with that key, which is never in the copy: keep the key (and
  earlier ones) as long as the copies.
- **Volume snapshots** (optional, primary where available) need the CSI snapshot support above and a schedule (Velero,
  your platform's backup).
- Restores and the one-time move use the loader pod (`tools/loader-pod.yaml`): the Deployment scaled to 0, `kubectl cp`.

### Moving in

The data comes from the interim host, which already runs the SQLite build (its Postgres data was imported there on
2026-10-21 and the Postgres removed): its database file goes onto the volume with the loader pod (§ Moving the data
in). An installation still on a Postgres release uses `adminforge db import-postgres` instead (same section). The
cluster needs nothing more than the loader pod, the same `TOKEN_CACHE_KEY` in `adminforge-env`, and the Entra
redirect URI for the new `PUBLIC_BASE_URL` (`pnpm adminforge provision entra`).

### Cluster readiness checklist

`P` = `preflight.sh` checks it.

- [ ] **Nodes**: amd64; at least one with 1 vCPU and 5 GiB of memory free for the pod and ~10 GB of free disk
      (recommended nodes: 4 vCPU / 16 GB). (P: architecture and what is allocatable)
- [ ] **Kubernetes 1.29 or later**, a supported minor. (P)
- [ ] **Namespace** `adminforge` labelled `pod-security.kubernetes.io/enforce: restricted`. (P)
- [ ] **No admission policy** that demands CPU limits or injects sidecars; a ResourceQuota, if any, admits 750m CPU /
      2 GiB requests and 5 GiB memory limits.
- [ ] **Storage class**: CSI, block storage on SSD (never NFS, SMB, CephFS or FUSE), `fsGroupPolicy` not `None`,
      `WaitForFirstConsumer`, expansion allowed, encrypted at rest — the nodes' disks too. (P)
- [ ] **ReadWriteOncePod** admitted (P: server dry run); the driver supports it (first deploy:
      `kubectl describe pvc adminforge-data`).
- [ ] **Volume**: 10 GiB (20 GiB on a large tenant), watched; snapshots scheduled if you use them.
- [ ] **CNI enforces NetworkPolicy**, egress and `ipBlock` excepts included. (P: the API, and a known engine)
- [ ] **DNS pods** labelled `k8s-app: kube-dns` in `kube-system`, resolving public names and the Ingress name. (P)
- [ ] **Egress**: TCP 443 to the hosts in the table (Network), direct — no HTTP proxy, no TLS interception; the
      private addresses you need named in `networkpolicy-private-egress.yaml`; pods, nodes and Services on private
      ranges (P).
- [ ] **Ingress controller** with TLS and a trusted certificate for the DNS name (`PUBLIC_BASE_URL`); SSE
      unbuffered, idle read timeout ≥ 1 h, other requests ≥ 300 s, bodies ≥ 256 KiB; the real client address kept;
      `TRUST_PROXY` = the controller's pod network; the name reachable from inside the cluster. (P: an IngressClass)
- [ ] **Clocks** synced on every node (NTP / chrony).
- [ ] **Registry** the nodes can pull from (P: the pull secret, when named); a build machine (amd64, Docker with
      BuildKit).
- [ ] **Secrets** encrypted at rest; `get` on Secrets, `pods/exec`, and changing pods, the Deployment or
      NetworkPolicies in the namespace only for AdminForge's operators.
- [ ] **Logs** of the api container shipped off the cluster (required), kept as long as the audit history must be
      provable.
- [ ] **Backups**: an operator's machine with `kubectl` and `gpg`, a place off the cluster for the encrypted copies,
      and the audit chain key kept as long as them (a keyed copy verifies only with it).
- [ ] **The interim host's database** ready to move: its service stopped and the file copied (§ Moving the data in), the
      same `TOKEN_CACHE_KEY` in the Secret.

## 1. Build and push the images

```bash
portal/deploy/kubernetes/build-images.sh --dry-run   # fetches origin's main, prints the build record, builds nothing
portal/deploy/kubernetes/build-images.sh --registry registry.example.com/adminforge --push
```

Both images are built from the `HEAD` commit itself (`git archive`: uncommitted, untracked and git-ignored files are
never in them) and tagged with it. The script runs `git fetch origin refs/heads/main` itself (read-only) and stops if it
can't: the app image records in `/app/BUILD.json` whether that commit is merged to origin's `main` as fetched then —
the review rule `adminforge publish` enforces. The record holds `commit`, `reviewed`, `mainCommit` (the fetched `main`
commit), `remote` (origin's URL without credentials) and `contentDir`; `publish` doesn't trust a record without
`mainCommit`. Publishing from an image of any other commit needs `--allow-unreviewed`, which the audit log records. Pin
the pushed digests in your overlay.

The images the builds start from are pinned by digest too (`name:tag@sha256:…` in each `FROM`, and the `# syntax=`
frontend; `tests/guards/image-digests.test.ts`), so rebuilding a commit gets the same bases (the runner then adds the
Ubuntu updates of the build's day, and the PowerShell archive its Dockerfile pins by version and SHA-256). To move to
a newer base, change tag and digest together — Dependabot's docker ecosystem does that for the directories
`.github/dependabot.yml` watches, or by hand with the index digest from `docker buildx imagetools inspect <image>:<tag>`
— and rebuild. A pin only moves when someone moves it, and a tag that is no longer rebuilt never offers a newer digest:
the reason the runner left MCR's PowerShell image, whose `7.5-ubuntu-24.04` was last rebuilt on 2025-01-30.

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
settings, `TOKEN_CACHE_KEY`, `RUNNER_SHARED_KEY` and, for schedules, the automation identity —
`adminforge env check --for portal,schedules` on the file tells you what is missing. Add `AUDIT_CHAIN_KEY`
(`openssl rand -base64 32`, not `TOKEN_CACHE_KEY`; § Audit log): `env check` warns without it, and once set it can be
rotated but not removed. The pod's layout (`DATABASE_PATH`, `API_HOST`, ports, `NODE_ENV`, `CONTENT_SOURCE`) comes from
the ConfigMap and wins over the Secret, so a copied env file can't move the database off the volume. Keys of the
Postgres releases (`DATABASE_URL`, `*_IN_PROCESS`, …) are ignored; `env check` lists them so you can drop them.

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
# edit: images, host name, storage class, the ingress controller's namespace and pod network (TRUST_PROXY), and the
# private addresses the pod may reach (networkpolicy-private-egress.yaml)
kubectl apply -k ~/adminforge-cluster
kubectl -n adminforge rollout status deploy/adminforge
```

The API creates the database file (mode 0600) and applies the migrations before it listens — the startup probe allows
for that. `GET /readyz` answers
`{"status":"ok","checks":{"db":"ok","worker":"ok","scheduler":"ok","auditChain":"keyed"}}` once the run worker and the
scheduler have reported in (`"auditChain":"unkeyed"` until `AUDIT_CHAIN_KEY` is set; it never makes the answer
`degraded`).

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
   playbook steps get 10 s to reach a checkpoint; a step still in flight then is interrupted and, after the restart,
   retried — or the run ends `needs_review` if the step is `idempotent: false`; unfinished jobs are queued again), then
   the new pod migrates and starts.
4. Publish the content of the new image (step 4). After a release that bumps the content schema version,
   `publish --dry-run` lists the published rows stamped with an older one and whether they still pass.

## Moving the data in (once)

**From the interim host** (the SQLite build, which holds this installation's data since 2026-10-21). Stop it so
nothing is written after the copy, then take the database file together with its `-wal` and `-shm`, where SQLite left
them:

```bash
systemctl --user stop adminforge-sqlite
cd ~/.local/share/adminforge/sqlite && tar -czf ~/adminforge-move.tgz adminforge.db*
```

Put the files on the volume with the loader pod (the Deployment scaled to 0 — instructions in `tools/loader-pod.yaml`)
and scale back to 1; the API checks and migrates the database at start. Use the **same `TOKEN_CACHE_KEY`** in
`adminforge-env`: schedules that run with their creator's access keep their sealed grant tokens (people sign in again
at the cluster's address).
(`adminforge db backup` also gives a consistent copy, without stopping the service, but leaves the tokens out: creators
then consent again to their schedules.) Keep the host's copy until you are satisfied,
then retire the host.

**From a Postgres release** (an installation that never ran the SQLite build). `adminforge db import-postgres` copies
its state — settings, preferences, saved views, definitions, schedules and their grants, runs with steps and events,
approvals, schedule history, probe results, News and changes, and the audit log with its hash chain (re-verified; its
tail must equal Postgres') — into a new SQLite file; signed-in sessions are not copied. With the old services stopped,
from a checkout of this release on that host:

```bash
# The services' database: the host overlay's DATABASE_URL (the URL is read from the env files, never typed).
ADMINFORGE_ENV_OVERLAY=host pnpm adminforge db import-postgres --dry-run
ADMINFORGE_ENV_OVERLAY=host pnpm adminforge db import-postgres --to ~/adminforge-import/adminforge.db
```

Then the loader pod and the same `TOKEN_CACHE_KEY`, as above. Keep the last `pg_dump` until you are satisfied.

## Backups

The database holds history (audit log, runs, approvals, schedules, settings); the Secret holds the keys
(`TOKEN_CACHE_KEY`, `AUDIT_CHAIN_KEY`, app secrets). Back up both, separately.

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

  Each copy is recorded in the audit log before it leaves (`database.backup`: account and machine — in the pod the
  image's user and the pod's name, so note who ran it; `kubectl exec` itself is in the cluster's audit log —, stdout
  or file, plaintext, bytes, the copy's tail seq); if the event can't be written nothing is written out, so the
  account running it needs write access to the database. With `AUDIT_CHAIN_KEY` set, the copy verifies only with that
  key, which is never in it: keep the key (and earlier ones) as long as the copies.

  Restore: decrypt, then the loader pod (as in the data move). After a restore from a logical copy everyone signs in
  again, and creators re-consent schedules that run with their access.

## Audit log

The audit log is append-only in the database (triggers) and hash-chained. The triggers stop the application rewriting
history; they don't stop someone with write access to the volume (SQLite has no roles — ADR-016). What detects that
is the chain and its **checkpoints**: the API logs `audit chain checkpoint` lines (the audit-chain probe and the Audit
page). Forward the container logs off the cluster (Container Insights / Log Analytics, or your log store) — required —
and compare them with:

```bash
kubectl -n adminforge exec deploy/adminforge -c api -- adminforge audit verify
```

With `AUDIT_CHAIN_KEY` in `adminforge-env` the chain is HMAC-keyed from a cut-over the API appends at start, so
changing an event needs the key; pin it with `AUDIT_CHAIN_KEYED_SINCE` (the seq of the first `audit chain cut-over`
line). Check a shipped checkpoint or cut-over line:

```bash
kubectl -n adminforge exec deploy/adminforge -c api -- adminforge audit verify --checkpoint <seq>:<hash>
```

Setting, rotating and losing the key: `docs/operations.md` → Audit chain checkpoints.

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

| Symptom                                                                        | Cause and fix                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pod `Pending`: volume node affinity / multi-attach                             | The disk is zonal and the pod was scheduled elsewhere, or the old pod still holds it. Wait for the old pod to end; pin the zone in the overlay.                                                                                                 |
| `The database in DATABASE_PATH is not safe to use: … network filesystem`       | The storage class is Azure Files/NFS/FUSE. Use a disk class (`managed-csi`) and move the data (loader pod).                                                                                                                                     |
| `… can be read or written by other users` / `owned by another user`            | The file's mode or owner changed (copied in as another user). With the loader pod, copy it off, delete it and copy it back in (it then belongs to the API's user), `chmod 600`.                                                                 |
| `/readyz` says `degraded` (`worker` or `scheduler` not `ok`)                   | The process is up but made no progress for two minutes: the scheduler's ticks fail or it lost its lease, or the run worker's queue polls fail (look for errors in the log). A restart recovers; report it if it recurs.                         |
| `The database is busy (another process is writing)` from the CLI               | A long write in the API (retention, a large publish) held the lock past `DATABASE_BUSY_TIMEOUT_MS`. Run the command again.                                                                                                                      |
| Sign-in loops or `invalid_state`                                               | `PUBLIC_BASE_URL` differs from the Ingress URL, or the apps lack it as a redirect URI (`provision entra`).                                                                                                                                      |
| Run streams or the event dock never update                                     | The ingress buffers Server-Sent Events: `proxy-buffering: off` and a long read timeout (overlay `ingress.yaml`).                                                                                                                                |
| Portal readiness probe red, or a Private Link / private Function App times out | The base NetworkPolicy refuses private addresses on 443. Name the address (or the ingress controller's pods) in the overlay's `networkpolicy-private-egress.yaml`.                                                                              |
| `runner` restarts with `OOMKilled`                                             | More PowerShell workers than its memory limit holds (~0.35 GB each; up to `RUNNER_POOL_SIZE` + `RUNNER_MAX_JOBS` of them, six by default, in 3 GiB). Raise the limit, or set a lower `RUNNER_MAX_JOBS` on the runner container, in the overlay. |
| Pod evicted: `ephemeral local storage` / `emptyDir` over its `sizeLimit`       | A `/tmp` filled up — on the api usually during `adminforge db backup -`, which stages a copy of the database there. Raise that volume's `sizeLimit` in the overlay above the database's size.                                                   |
