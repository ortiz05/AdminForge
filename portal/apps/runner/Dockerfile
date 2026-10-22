# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
#
# AdminForge runner: Node 26 supervisor + single-use PowerShell 7 workers with pinned modules.
# Build from the repository root (the context needs the workspace files). With BuildKit (docker buildx),
# Dockerfile.dockerignore next to this file keeps node_modules and the local modules/ out of the context:
#   docker build -f portal/apps/runner/Dockerfile -t adminforge-runner .
# Run (configuration comes from the environment; nothing tenant-specific is baked in), locked down as the pod runs it:
#   docker run --rm --read-only --tmpfs /tmp --tmpfs /home/adminforge:uid=10002,gid=10002 --cap-drop ALL \
#     --security-opt no-new-privileges -e RUNNER_SHARED_KEY=... -p 127.0.0.1:3101:3101 adminforge-runner
#
# Base images are pinned by digest, the tag kept beside it (S-37; tests/guards/image-digests.test.ts), and named
# literally in each FROM so Dependabot's docker ecosystem bumps tag and digest together. Looked up 2026-10-22:
#   ubuntu:24.04 — noble-20260930.1, the multi-platform index (linux/amd64, arm64/v8, arm/v7, ppc64le, riscv64, s390x).
#   A build also installs Ubuntu's updates of its day (apt-get upgrade, the os stage). Dependabot proposes each new
#   24.04 digest; a move to another Ubuntu release is a reviewed change (.github/dependabot.yml ignores those).
#   node:26.11.1-bookworm-slim — the multi-platform index (linux/amd64, linux/arm64/v8, linux/ppc64le); only its node
#   binary reaches the runtime.
#   docker/dockerfile:1.7 (the `# syntax=` frontend) — pinned the same way.
# PowerShell is Microsoft's release archive, checked against the SHA-256 the release publishes; its version and hash
# (the powershell stage) are a reviewed bump that Dependabot doesn't see (tests/guards/runner-powershell-download.test.ts).
# MCR's PowerShell images are not rebuilt (7.5-ubuntu-24.04 last on 2025-01-30, PowerShell 7.5.0), so the runner no
# longer starts from one. The image is linux/amd64: the archive is linux-x64 and the Deployment selects amd64 nodes
# (portal/deploy/kubernetes/README.md → Requirements › CPU architecture, which says what arm64 would take).

# ── Build the supervisor bundle (one self-contained file, no node_modules at runtime) ──────────────
FROM node:26.11.1-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS build
WORKDIR /src
# Node 25 and later no longer bundle Corepack: install it (pinned), and it provides the pnpm that package.json's
# packageManager names.
RUN npm install --global --ignore-scripts corepack@0.36.0 && corepack enable pnpm
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY portal/apps/runner/package.json portal/apps/runner/tsconfig.json portal/apps/runner/tsup.config.ts portal/apps/runner/
RUN pnpm install --frozen-lockfile --filter @adminforge/runner
COPY portal/apps/runner/src portal/apps/runner/src
RUN pnpm --filter @adminforge/runner build

# ── Ubuntu with today's updates and the libraries PowerShell needs (its .deb's Depends, plus the CA store) ──
# libatomic1 is the node binary's (copied from the build stage); Ubuntu's minimal image doesn't have it. The setuid and
# setgid bits go (su, passwd, mount …): nothing in the runner needs them, and without the pod's no-new-privileges a
# plain `docker run` would otherwise keep them.
FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac AS os
# build-images.sh passes the day (UBUNTU_UPDATES=YYYY-MM-DD): a build cache keeps this layer for that day only, and the
# next day's build installs the updates published since. A plain `docker build` reuses its cached layer.
ARG UBUNTU_UPDATES=cached
RUN echo "Ubuntu updates: ${UBUNTU_UPDATES}" \
 && export DEBIAN_FRONTEND=noninteractive \
 && apt-get update \
 && apt-get upgrade -y --with-new-pkgs \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      libatomic1 \
      libc6 \
      libgcc-s1 \
      libgssapi-krb5-2 \
      libicu74 \
      libssl3t64 \
      libstdc++6 \
      zlib1g \
 && rm -rf /var/lib/apt/lists/* \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} +

# ── PowerShell from Microsoft's release archive, verified before it is unpacked (curl stays in this stage) ──
# To move to a newer release: its version, and the powershell-<version>-linux-x64.tar.gz line of that release's
# hashes.sha256 (github.com/PowerShell/PowerShell/releases/download/v<version>/hashes.sha256); then rebuild and run
# the runner's tests and a read-only job (portal/apps/runner/README.md → Container image).
FROM os AS powershell
ARG POWERSHELL_VERSION=7.6.7
ARG POWERSHELL_SHA256=6896f9e3a6b0a354bf470835a96da76d2f801cd50dcf047ad7c4563bf93bf431
RUN arch="$(dpkg --print-architecture)" && [ "$arch" = amd64 ] \
 || { echo "The runner image is built for amd64 only, and this machine is $arch: build it on an amd64 machine (portal/deploy/kubernetes/README.md → Requirements › CPU architecture)." >&2; exit 1; }
# The two ARGs are checked before they are used: an override (--build-arg) can name another release, never another
# repository or a check line of its own; printf, unlike dash's echo, doesn't interpret backslashes in them.
RUN case "${POWERSHELL_VERSION}" in ''|*[!0-9.]*) echo "POWERSHELL_VERSION is a release number (7.6.7)" >&2; exit 1 ;; esac \
 && printf '%s' "${POWERSHELL_SHA256}" | grep -Eqx '[0-9a-f]{64}' \
 && export DEBIAN_FRONTEND=noninteractive \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 --output /tmp/powershell.tar.gz \
      "https://github.com/PowerShell/PowerShell/releases/download/v${POWERSHELL_VERSION}/powershell-${POWERSHELL_VERSION}-linux-x64.tar.gz" \
 && printf '%s  %s\n' "${POWERSHELL_SHA256}" /tmp/powershell.tar.gz | sha256sum --check --strict - \
 && mkdir -p /opt/microsoft/powershell/7 \
 && tar -xzf /tmp/powershell.tar.gz -C /opt/microsoft/powershell/7 --no-same-owner \
 && chmod 0755 /opt/microsoft/powershell/7/pwsh \
 && chmod -R go-w,a-s /opt/microsoft/powershell \
 && rm /tmp/powershell.tar.gz

# ── The PowerShell base of the next two stages: the verified install, at the path MCR's images used ──
FROM os AS pwsh
COPY --from=powershell /opt/microsoft/powershell/7 /opt/microsoft/powershell/7
RUN ln -s /opt/microsoft/powershell/7/pwsh /usr/bin/pwsh

# ── Install exactly the module versions in modules.lock.json (runtime modules only, no Pester) ─────
FROM pwsh AS modules
COPY portal/apps/runner/modules.lock.json /build/modules.lock.json
# install-modules.ps1 dot-sources RunnerModules.ps1 next to it.
COPY portal/apps/runner/scripts /build/scripts
RUN POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off \
    pwsh -NoLogo -NoProfile -NonInteractive -File /build/scripts/install-modules.ps1 -Production -Destination /opt/adminforge/modules

# ── Runtime ──────────────────────────────────────────────────────────────────────────────────────
FROM pwsh AS runtime
COPY --from=build /usr/local/bin/node /usr/local/bin/node
# A fixed numeric uid: Kubernetes verifies runAsNonRoot only against a number (portal/deploy/kubernetes).
RUN groupadd --gid 10002 adminforge \
 && useradd --uid 10002 --gid 10002 --create-home --home-dir /home/adminforge --shell /usr/sbin/nologin adminforge

WORKDIR /app
# Layout mirrors portal/apps/runner so the bundle finds ps/worker.ps1 and modules.lock.json next to dist/.
COPY --from=build /src/portal/apps/runner/dist ./dist
COPY --from=modules /opt/adminforge/modules ./modules
COPY portal/apps/runner/ps ./ps
COPY portal/apps/runner/modules.lock.json ./modules.lock.json
# Default scripts; compose can mount portal/content/scripts here read-only instead.
COPY portal/content/scripts ./scripts

# LANG gives PowerShell (and the workers, which inherit it) the en-US culture and UTF-8 that MCR's image set; no
# LC_ALL, which would need the locales package's data to be valid for the C library.
# PWSH_PATH: the supervisor starts exactly the verified pwsh, never one found on PATH or in a writable HOME.
ENV NODE_ENV=production \
    LANG=en_US.UTF-8 \
    PWSH_PATH=/opt/microsoft/powershell/7/pwsh \
    RUNNER_HOST=0.0.0.0 \
    RUNNER_PORT=3101 \
    ADMINFORGE_SCRIPTS_DIR=/app/scripts \
    ADMINFORGE_RUNNER_MODULES_DIR=/app/modules \
    POWERSHELL_TELEMETRY_OPTOUT=1 \
    POWERSHELL_UPDATECHECK=Off \
    DOTNET_CLI_TELEMETRY_OPTOUT=1

USER 10002:10002
# Listens on all interfaces inside the container only: publish on 127.0.0.1 or an internal network. As the
# AdminForge pod's sidecar it listens on the pod's loopback (RUNNER_HOST=127.0.0.1 in the Deployment).
EXPOSE 3101
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 CMD ["node", "dist/healthcheck.js"]
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
