# ADR-017: Kubernetes, one pod

Status: accepted (2026-10-20); supersedes ADR-008

## Context

ADR-008 ran AdminForge on one host as systemd user units with Caddy in front and Postgres in Docker. The owner moved
the deployment to Kubernetes with the database on a PersistentVolume (ADR-016), and chose Kubernetes only: the host
deployment is retired rather than kept as a second path to maintain.

## Decision

- Two images: the app (API + run worker + scheduler, the built web app, the `adminforge` CLI, the content) and the
  existing PowerShell runner.
- One Deployment, `replicas: 1`, `strategy: Recreate`: the api container and the runner as a sidecar on the pod's
  loopback (it gets only `RUNNER_SHARED_KEY`). A PersistentVolumeClaim `adminforge-data` (ReadWriteOncePod, block
  storage — never Azure Files/NFS) at `/var/lib/adminforge` for the SQLite file and report files.
- Locked down: non-root fixed uids, read-only root file systems, no capabilities, no privilege escalation, RuntimeDefault
  seccomp, no service-account token, the restricted Pod Security Standard; a NetworkPolicy allowing ingress to the
  HTTP port and egress to DNS and 443 except the cloud metadata service.
- Configuration comes from the environment: a Secret made from the env file (the installation's settings) and a
  ConfigMap (the pod's layout, which wins). Admin-only keys never reach the cluster.
- The API migrates the database at startup (no older version runs during `Recreate`). Content is published from the
  image with `kubectl exec … adminforge publish`; the image's BUILD.json records whether its content was reviewed.
- kustomize: `portal/deploy/kubernetes/base` (nothing installation-specific) and an example overlay to copy.

## Consequences

- The systemd units, Caddy configuration, service-account installer, Postgres container and hardening scripts, and
  the backup timer are removed (git history keeps them). This host keeps running the last Postgres release until the
  cluster takes over; the data moves with `adminforge db import-postgres`.
- TLS, DNS and the certificate are the cluster's (Ingress), no longer Caddy's local CA.
- Live validation (`tests/live`) targets the Ingress URL (`PUBLIC_BASE_URL`).
- Not yet verified on a real cluster: storage classes, Ingress behaviour with Server-Sent Events, Pod Security
  admission (docs/backlog.md).
