#!/usr/bin/env bash
# Read-only preflight for a cluster that is to run AdminForge: checks what README.md → Requirements asks of the
# cluster, as far as kubectl can see it from here.
#
#   portal/deploy/kubernetes/preflight.sh [--namespace N] [--storage-class C] [--pull-secret S] [--context X]
#
#   --namespace      the namespace AdminForge goes into (default adminforge); it must exist, labelled restricted
#   --storage-class  the class the database volume will use (default: the cluster's default class)
#   --pull-secret    an image pull secret the overlay will name (asked for its type only)
#   --context        a kubeconfig context other than the current one
#
# kubectl is used for reads only — get, api-resources — and one server-side dry run of the database claim
# (`create --dry-run=server`: the API server validates and admits it, and stores nothing). One line per check:
# ✓ met, ✗ not met (with what to do), ⚠ advice, or something kubectl can't see with your access. Names and states
# only: a Secret is asked for its type, never its data. Exit 0 when nothing is ✗, 1 when something is, 2 on a usage
# error. What kubectl can't check (node clocks, egress to Microsoft, the ingress controller's settings, backups, log
# shipping) is in the README's cluster readiness checklist.
set -uo pipefail

NAMESPACE=adminforge
CLASS=""
PULL_SECRET=""
CONTEXT=""
NAME_RE='^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$'

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; }
value() {
  if [ $# -lt 2 ] || [ -z "$2" ]; then
    echo "✗ $1 needs a value (--help lists the options)" >&2
    exit 2
  fi
}
name() {
  if ! printf '%s' "$2" | grep -Eq "$NAME_RE"; then
    echo "✗ $1: \"$2\" is not a Kubernetes name" >&2
    exit 2
  fi
}
while [ $# -gt 0 ]; do
  case "$1" in
    --namespace) value "$@"; name "$1" "$2"; NAMESPACE="$2"; shift 2 ;;
    --storage-class) value "$@"; name "$1" "$2"; CLASS="$2"; shift 2 ;;
    --pull-secret) value "$@"; name "$1" "$2"; PULL_SECRET="$2"; shift 2 ;;
    --context) value "$@"; CONTEXT="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "✗ unknown option: $1 (--help lists the options)" >&2; exit 2 ;;
  esac
done

FAILED=0
ok() { printf '✓ %s\n' "$*"; }
bad() { printf '✗ %s\n' "$*"; FAILED=$((FAILED + 1)); }
warn() { printf '⚠ %s\n' "$*"; }

if ! command -v kubectl > /dev/null 2>&1; then
  bad "kubectl is not on PATH"
  exit 1
fi

k() {
  if [ -n "$CONTEXT" ]; then kubectl --context "$CONTEXT" "$@"; else kubectl "$@"; fi
}
# run <kubectl args…>: OUT = its output, ERR = the first line of its error output; returns kubectl's status.
OUT=""
ERR=""
run() {
  local errf rc
  errf="$(mktemp)"
  OUT="$(k "$@" 2> "$errf")"
  rc=$?
  ERR="$(head -n 1 "$errf" | tr -d '\r' | cut -c1-240)"
  rm -f "$errf"
  return $rc
}

if [ -n "$CONTEXT" ]; then
  CONTEXT_NAME="$CONTEXT"
elif run config current-context; then
  CONTEXT_NAME="$OUT"
else
  CONTEXT_NAME="(none)"
fi
echo "AdminForge cluster preflight (read-only) — context $CONTEXT_NAME, namespace $NAMESPACE"

# ── Kubernetes version: ReadWriteOncePod is GA in 1.29 ───────────────────────────────────────────────
if ! run get --raw /version; then
  bad "can't reach the cluster: ${ERR:-kubectl failed}"
  exit 1
fi
MAJOR="$(printf '%s' "$OUT" | sed -n 's/.*"major"[^"]*"\([0-9]*\).*/\1/p' | head -n 1)"
MINOR="$(printf '%s' "$OUT" | sed -n 's/.*"minor"[^"]*"\([0-9]*\).*/\1/p' | head -n 1)"
if [ -z "$MAJOR" ] || [ -z "$MINOR" ]; then
  bad "couldn't read the server's version"
elif [ "$MAJOR" -gt 1 ] || [ "$MINOR" -ge 29 ]; then
  ok "Kubernetes $MAJOR.$MINOR (1.29+: ReadWriteOncePod is generally available)"
else
  bad "Kubernetes $MAJOR.$MINOR — AdminForge needs 1.29+ (ReadWriteOncePod for the database volume): upgrade the cluster"
fi

# ── The namespace and its Pod Security Standard ──────────────────────────────────────────────────────
NS_OK=0
if run get namespace "$NAMESPACE" -o 'jsonpath={.metadata.labels.pod-security\.kubernetes\.io/enforce}'; then
  NS_OK=1
  if [ "$OUT" = restricted ]; then
    ok "namespace $NAMESPACE enforces the restricted Pod Security Standard"
  else
    bad "namespace $NAMESPACE doesn't enforce the restricted Pod Security Standard (enforce: ${OUT:-not set}) — label it pod-security.kubernetes.io/enforce=restricted (overlays/example/namespace.yaml)"
  fi
else
  bad "namespace $NAMESPACE: ${ERR:-not readable} — create it with the restricted label (overlays/example/namespace.yaml)"
fi

# ── Storage: a CSI block-storage class that applies fsGroup ──────────────────────────────────────────
DEFAULT_NOTE=""
if [ -z "$CLASS" ]; then
  if run get storageclass -o 'jsonpath={range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.storageclass\.kubernetes\.io/is-default-class}{"\n"}{end}'; then
    CLASS="$(printf '%s\n' "$OUT" | awk -F'\t' '$2 == "true" { print $1; exit }')"
    DEFAULT_NOTE=" (the default)"
    [ -n "$CLASS" ] || bad "no default storage class — name the database volume's class with --storage-class (block storage: README.md → Requirements › Storage)"
  else
    bad "can't list storage classes: $ERR"
  fi
fi
# Network and FUSE file systems, where SQLite's locking corrupts databases (the API refuses them: db/file-check.ts).
FILE_RE='(^|[^a-z])(nfs|smb|cifs|azurefile|azure-file|file\.csi\.azure\.com|blob\.csi\.azure\.com|blobfuse|fuse|efs\.csi\.aws\.com|fsx\.csi\.aws\.com|filestore|cephfs|glusterfs|lustre|juicefs|seaweedfs|s3|gcsfuse|objectivefs|beegfs|nas)([^a-z]|$)'
if [ -n "$CLASS" ]; then
  if run get storageclass "$CLASS" -o 'jsonpath={.provisioner}{"\t"}{.volumeBindingMode}{"\t"}{.allowVolumeExpansion}{"\t"}{.parameters}'; then
    PROV="$(printf '%s' "$OUT" | cut -f1)"
    BINDING="$(printf '%s' "$OUT" | cut -f2)"
    EXPAND="$(printf '%s' "$OUT" | cut -f3)"
    PARAMS="$(printf '%s' "$OUT" | cut -f4-)"
    if printf '%s %s' "$PROV" "$PARAMS" | tr '[:upper:]' '[:lower:]' | grep -Eq "$FILE_RE"; then
      bad "storage class $CLASS$DEFAULT_NOTE: $PROV is a network or FUSE file system — SQLite corrupts databases there and the API refuses to start: use a block-storage (disk) class"
    else
      ok "storage class $CLASS$DEFAULT_NOTE: $PROV (not a network or FUSE file system)"
    fi
    # In-tree provisioners are served by their CSI drivers (CSI migration).
    case "$PROV" in
      kubernetes.io/azure-disk) DRIVER=disk.csi.azure.com ;;
      kubernetes.io/aws-ebs) DRIVER=ebs.csi.aws.com ;;
      kubernetes.io/gce-pd) DRIVER=pd.csi.storage.gke.io ;;
      kubernetes.io/vsphere-volume) DRIVER=csi.vsphere.vmware.com ;;
      kubernetes.io/cinder) DRIVER=cinder.csi.openstack.org ;;
      *) DRIVER="$PROV" ;;
    esac
    if run get csidriver "$DRIVER" -o 'jsonpath={.spec.fsGroupPolicy}'; then
      POLICY="${OUT:-ReadWriteOnceWithFSType}"
      case "$POLICY" in
        None)
          bad "CSI driver $DRIVER never applies the pod's fsGroup (fsGroupPolicy: None) — the API (uid 10001) couldn't write the volume: use another class" ;;
        File)
          ok "CSI driver $DRIVER applies the pod's fsGroup (fsGroupPolicy: File)" ;;
        *)
          if printf '%s' "$PARAMS" | grep -Eiq '(csi\.storage\.k8s\.io/)?fstype'; then
            ok "CSI driver $DRIVER applies the pod's fsGroup to volumes with a file system type (fsGroupPolicy: $POLICY)"
          else
            warn "CSI driver $DRIVER applies the pod's fsGroup only to volumes with a file system type (fsGroupPolicy: $POLICY), and class $CLASS names none — check that its volumes get one (spec.csi.fsType of a provisioned PersistentVolume)"
          fi ;;
      esac
    else
      bad "provisioner $PROV is not a CSI driver (${ERR:-no CSIDriver $DRIVER}) — ReadWriteOncePod needs one: use a CSI block-storage class"
    fi
    if [ "$BINDING" = WaitForFirstConsumer ]; then
      ok "storage class $CLASS binds volumes where the pod is scheduled (WaitForFirstConsumer)"
    else
      warn "storage class $CLASS binds volumes ${BINDING:-Immediate} — a zonal disk can then be made in a zone the pod can't run in: prefer volumeBindingMode WaitForFirstConsumer"
    fi
    if [ "$EXPAND" = true ]; then
      ok "storage class $CLASS allows volume expansion (the database volume can grow later)"
    else
      warn "storage class $CLASS doesn't allow volume expansion — size the database volume for the long run (README.md → Requirements › Storage)"
    fi
  else
    bad "storage class $CLASS: ${ERR:-not readable}"
    CLASS=""
  fi
fi

# ── ReadWriteOncePod, admitted by the API server (a dry run: nothing is created) ─────────────────────
if [ "$NS_OK" = 1 ] && [ -n "$CLASS" ]; then
  if run -n "$NAMESPACE" create --dry-run=server -o name -f - << EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: adminforge-preflight
spec:
  accessModes: [ReadWriteOncePod]
  storageClassName: $CLASS
  resources:
    requests:
      storage: 10Gi
EOF
  then
    ok "the API server admits a ReadWriteOncePod claim on $CLASS (server-side dry run, nothing created; the driver's own support shows when the first volume is provisioned)"
  else
    bad "a ReadWriteOncePod claim on $CLASS was refused: ${ERR:-no reason given}"
  fi
else
  warn "ReadWriteOncePod not checked: that needs the namespace and a storage class"
fi

# ── Network policy: the API, an engine that enforces it, and the DNS pods the policy allows ──────────
if run api-resources --api-group=networking.k8s.io -o name; then
  if printf '%s\n' "$OUT" | grep -qx 'networkpolicies.networking.k8s.io'; then
    ok "NetworkPolicy API present (networking.k8s.io/v1)"
  else
    bad "the cluster serves no NetworkPolicy API — AdminForge's network policy can't apply"
  fi
else
  bad "can't list the networking.k8s.io API: ${ERR:-kubectl failed}"
fi
if run get daemonsets --all-namespaces -o 'jsonpath={range .items[*]}{.metadata.name}{"\n"}{end}'; then
  ENGINE="$(printf '%s\n' "$OUT" | grep -Eo '^(calico-node|cilium|azure-npm|antrea-agent|kube-router|weave-net|canal|kube-ovn-cni|ovnkube-node)' | sort -u | paste -sd, -)"
  if [ -n "$ENGINE" ]; then
    ok "a network policy engine runs: $ENGINE"
  else
    warn "no known network policy engine among the DaemonSets (Calico, Cilium, Azure NPM, Antrea, kube-router …) — make sure your CNI enforces NetworkPolicy: without it any pod can reach the API and forge X-Forwarded-For"
  fi
else
  warn "couldn't list DaemonSets to look for a network policy engine (${ERR:-kubectl failed}) — make sure your CNI enforces NetworkPolicy"
fi
if run -n kube-system get pods -l k8s-app=kube-dns -o name; then
  if [ -n "$OUT" ]; then
    ok "the cluster's DNS pods carry k8s-app=kube-dns in kube-system (the network policy's DNS rule)"
  else
    bad "no pods labelled k8s-app=kube-dns in kube-system — the network policy allows DNS only to those: point its DNS rule at your resolver's pods in the overlay"
  fi
else
  warn "couldn't list the DNS pods in kube-system (${ERR:-kubectl failed}) — the network policy allows DNS only to pods labelled k8s-app=kube-dns there"
fi

# ── Nodes: amd64 (the runner image), room for the pod's limits ───────────────────────────────────────
if run get nodes -o 'jsonpath={range .items[*]}{.metadata.name}{"\t"}{.status.nodeInfo.architecture}{"\t"}{.status.allocatable.cpu}{"\t"}{.status.allocatable.memory}{"\t"}{.status.allocatable.ephemeral-storage}{"\t"}{.spec.unschedulable}{"\n"}{end}'; then
  STATS="$(printf '%s\n' "$OUT" | awk -F'\t' '
  function bytes(q,   n, u) {
    n = q + 0; u = q; sub(/^[0-9.]+/, "", u)
    if (u == "Ki") return n * 1024; if (u == "Mi") return n * 1048576
    if (u == "Gi") return n * 1073741824; if (u == "Ti") return n * 1099511627776
    if (u == "k") return n * 1000; if (u == "M") return n * 1000000
    if (u == "G") return n * 1000000000; if (u == "T") return n * 1000000000000
    return n
  }
  function millicores(q) { return q ~ /m$/ ? q + 0 : (q + 0) * 1000 }
  $1 != "" {
    total++
    if ($2 != "amd64" || $6 == "true") next
    amd++
    if (millicores($3) >= 1000 && bytes($4) >= 5 * 1073741824 && bytes($5) >= 4 * 1073741824) roomy++
    else if (bytes($4) >= 2 * 1073741824) fits++
  }
  END { printf "%d %d %d %d\n", total, amd, roomy, fits }')"
  read -r TOTAL AMD ROOMY FITS <<< "$STATS"
  OTHERS=""
  [ "$TOTAL" -gt "$AMD" ] && OTHERS="; the pod selects kubernetes.io/arch=amd64, so other or unschedulable nodes are left alone"
  if [ "$TOTAL" -eq 0 ]; then
    warn "no nodes listed — check node architecture (amd64) and size by hand (README.md → Requirements › Node size)"
  elif [ "$AMD" -eq 0 ]; then
    bad "no schedulable amd64 node — the runner image is built for linux/amd64 only (README.md → Requirements › CPU architecture)"
  elif [ "$ROOMY" -gt 0 ]; then
    ok "$ROOMY of $AMD schedulable amd64 node(s) have ≥ 1 CPU, 5 GiB memory and 4 GiB ephemeral storage allocatable (the pod's limits; what is free depends on what else runs there)$OTHERS"
  elif [ "$FITS" -gt 0 ]; then
    warn "no schedulable amd64 node has 1 CPU, 5 GiB memory (the pod's limits: api 2 GiB + runner 3 GiB) and 4 GiB ephemeral storage allocatable — the requests (2 GiB) fit, but under load the pod may be OOM-killed or evicted: use larger nodes (README.md → Requirements › Node size)"
  else
    bad "no schedulable amd64 node has the 2 GiB of allocatable memory the pod requests (README.md → Requirements › Node size)"
  fi
else
  warn "couldn't list nodes (${ERR:-kubectl failed}) — check node architecture (amd64) and size by hand (README.md → Requirements › Node size)"
fi

# ── Ingress ──────────────────────────────────────────────────────────────────────────────────────────
if run get ingressclass -o 'jsonpath={range .items[*]}{.metadata.name}{"\t"}{.spec.controller}{"\n"}{end}'; then
  if [ -n "$OUT" ]; then
    ok "IngressClass: $(printf '%s\n' "$OUT" | awk -F'\t' 'NF { printf "%s%s (%s)", sep, $1, $2; sep = ", " }') — it must pass Server-Sent Events unbuffered (README.md → Requirements › Ingress)"
    if printf '%s\n' "$OUT" | cut -f2 | grep -qx 'k8s.io/ingress-nginx'; then
      warn "ingress-nginx (k8s.io/ingress-nginx) is retired upstream: no releases or security fixes since March 2026 — prefer a maintained controller, with the same settings"
    fi
  else
    bad "no IngressClass — install an ingress controller with TLS that passes Server-Sent Events unbuffered (README.md → Requirements › Ingress)"
  fi
else
  warn "couldn't list IngressClasses (${ERR:-kubectl failed})"
fi

# ── Image pull secret (its type only) ────────────────────────────────────────────────────────────────
if [ -n "$PULL_SECRET" ]; then
  if [ "$NS_OK" = 1 ] && run -n "$NAMESPACE" get secret "$PULL_SECRET" -o 'jsonpath={.type}'; then
    case "$OUT" in
      kubernetes.io/dockerconfigjson | kubernetes.io/dockercfg) ok "image pull secret $PULL_SECRET ($OUT)" ;;
      *) bad "secret $PULL_SECRET is of type ${OUT:-unknown}, not an image pull secret (kubernetes.io/dockerconfigjson)" ;;
    esac
  else
    bad "image pull secret $PULL_SECRET: ${ERR:-the namespace is missing} — create it (kubectl create secret docker-registry) or let the nodes pull with their own identity"
  fi
fi

if [ "$FAILED" -gt 0 ]; then
  echo "Result: $FAILED check(s) not met (✗ above). Then go through README.md → Cluster readiness checklist."
  exit 1
fi
echo "Result: nothing kubectl can see stands in the way. Go through README.md → Cluster readiness checklist for the rest."
exit 0
