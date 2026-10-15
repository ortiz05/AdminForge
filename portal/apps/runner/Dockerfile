# syntax=docker/dockerfile:1.7
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
ARG NODE_IMAGE=node:24.13.1-bookworm-slim
ARG PWSH_IMAGE=mcr.microsoft.com/powershell:7.5-ubuntu-24.04

# ── Build the supervisor bundle (one self-contained file, no node_modules at runtime) ──────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY portal/apps/runner/package.json portal/apps/runner/tsconfig.json portal/apps/runner/tsup.config.ts portal/apps/runner/
RUN pnpm install --frozen-lockfile --filter @adminforge/runner
COPY portal/apps/runner/src portal/apps/runner/src
RUN pnpm --filter @adminforge/runner build

# ── Install exactly the module versions in modules.lock.json (runtime modules only, no Pester) ─────
FROM ${PWSH_IMAGE} AS modules
COPY portal/apps/runner/modules.lock.json /build/modules.lock.json
COPY portal/apps/runner/scripts/install-modules.ps1 /build/scripts/install-modules.ps1
RUN pwsh -NoLogo -NoProfile -NonInteractive -File /build/scripts/install-modules.ps1 -Production -Destination /opt/adminforge/modules

# ── Runtime ──────────────────────────────────────────────────────────────────────────────────────
FROM ${PWSH_IMAGE} AS runtime
COPY --from=build /usr/local/bin/node /usr/local/bin/node
RUN groupadd --system adminforge \
 && useradd --system --gid adminforge --create-home --home-dir /home/adminforge --shell /usr/sbin/nologin adminforge

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

USER adminforge
# Listens on all interfaces inside the container only: publish on 127.0.0.1 or an internal network.
EXPOSE 3101
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 CMD ["node", "dist/healthcheck.js"]
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
