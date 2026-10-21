# Deploying AdminForge

AdminForge is deployed on Kubernetes only (ADR-017): one pod, with all of its state in one SQLite file on a
PersistentVolume (ADR-016). The runbook — requirements, images, Secrets, deploy, publishing content, upgrades, the
one-time move from the Postgres host, backups, audit checkpoints, operating and troubleshooting — is
[`kubernetes/README.md`](kubernetes/README.md). Day-to-day operations are in `docs/operations.md`.

| Path                               | What                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kubernetes/README.md`             | The deployment runbook                                                                                                                                                              |
| `kubernetes/Dockerfile`            | The app image: API (with the run worker and the scheduler), the built web app, the `adminforge` CLI, the content                                                                    |
| `kubernetes/build-images.sh`       | Builds both images (the runner's is `portal/apps/runner/Dockerfile`) tagged with the commit, and records whether the content was reviewed                                           |
| `kubernetes/adminforge.sh`         | `adminforge` in the app image: `kubectl exec deploy/adminforge -c api -- adminforge <command>`                                                                                      |
| `kubernetes/base/`                 | kustomize base, nothing installation-specific: Deployment (one replica, `Recreate`, api + runner sidecar), PVC `adminforge-data`, Service, ServiceAccount, NetworkPolicy, ConfigMap |
| `kubernetes/overlays/example/`     | An installation to copy: namespace (restricted Pod Security), images, Ingress with TLS, storage class, `TRUST_PROXY`                                                                |
| `kubernetes/tools/loader-pod.yaml` | A one-off pod that mounts the volume while AdminForge is stopped, to put a database file on it or take one off                                                                      |

`tests/guards/kubernetes-manifests.test.ts` checks the manifests: one replica with `Recreate`, the database on the
volume, locked-down containers without a Kubernetes API token, the runner on the pod loopback, the health probes, the
NetworkPolicy, and no installation or tenant values in the base (the example overlay pins its images).

The host deployment (systemd units, Caddy, the Postgres container and its hardening scripts, the backup timer) was
retired with ADR-017; the last Postgres release is in git history.
