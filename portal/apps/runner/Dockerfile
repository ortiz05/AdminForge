# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
#
# AdminForge runner: Node 24 supervisor + single-use PowerShell 7 workers with pinned modules.
# Build from the repository root (the context needs the workspace files). With BuildKit (docker buildx),
# Dockerfile.dockerignore next to this file keeps node_modules and the local modules/ out of the context:
#   docker build -f portal/apps/runner/Dockerfile -t adminforge-runner .
# Run (configuration comes from the environment; nothing tenant-specific is baked in):
#   docker run --rm -e RUNNER_SHARED_KEY=... -p 127.0.0.1:3101:3101 adminforge-runner
#
# Base images: MCR publishes no GA PowerShell 7.6 image (only preview-7.6-*), so the runtime uses the
# latest GA official image, 7.5 on Ubuntu 24.04. The pinned modules support PowerShell 7.4+.
# Both are pinned by digest, the tag kept beside it (S-37; tests/guards/image-digests.test.ts), and named literally in
# each FROM so Dependabot's docker ecosystem bumps tag and digest together. Looked up 2026-10-21:
#   node:24.13.1-bookworm-slim — the multi-platform index (linux/amd64, linux/arm64/v8, linux/ppc64le, linux/s390x).
#   mcr.microsoft.com/powershell:7.5-ubuntu-24.04 — a single linux/amd64 image, not an index: this image is amd64
#   only (MCR's arm64 PowerShell 7.5 images are separate tags on other distributions: 7.5-azurelinux-3.0-arm64,
#   7.5-mariner-2.0-arm64). The tag was last rebuilt on 2025-01-30 (PowerShell 7.5.0);
#   portal/deploy/kubernetes/README.md → Requirements › CPU architecture.
#   docker/dockerfile:1.7 (the `# syntax=` frontend) — pinned the same way.

# ── Build the supervisor bundle (one self-contained file, no node_modules at runtime) ──────────────
FROM node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2 AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY portal/apps/runner/package.json portal/apps/runner/tsconfig.json portal/apps/runner/tsup.config.ts portal/apps/runner/
RUN pnpm install --frozen-lockfile --filter @adminforge/runner
COPY portal/apps/runner/src portal/apps/runner/src
RUN pnpm --filter @adminforge/runner build

# ── Install exactly the module versions in modules.lock.json (runtime modules only, no Pester) ─────
FROM mcr.microsoft.com/powershell:7.5-ubuntu-24.04@sha256:042240d57ec9e47e511033b92625a8d95875ee5860af3015992c248b58a8be81 AS modules
COPY portal/apps/runner/modules.lock.json /build/modules.lock.json
# install-modules.ps1 dot-sources RunnerModules.ps1 next to it.
COPY portal/apps/runner/scripts /build/scripts
RUN pwsh -NoLogo -NoProfile -NonInteractive -File /build/scripts/install-modules.ps1 -Production -Destination /opt/adminforge/modules

# ── Runtime ──────────────────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/powershell:7.5-ubuntu-24.04@sha256:042240d57ec9e47e511033b92625a8d95875ee5860af3015992c248b58a8be81 AS runtime
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

ENV NODE_ENV=production \
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
