# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
#
# AdminForge app image (ADR-017): the API — which is also the run worker and the scheduler (ADR-016) — the built web
# app it serves, the `adminforge` CLI (publish, audit verify, db backup / import-postgres) and the content to publish.
# The PowerShell runner is its own image (portal/apps/runner/Dockerfile), the pod's sidecar.
#
# Build from the repository root with portal/deploy/kubernetes/build-images.sh: it records the commit and whether its
# content was reviewed (committed and merged to origin/main) in /app/BUILD.json, which `adminforge publish` in the pod
# checks instead of git. Nothing tenant-specific is baked in: configuration comes from the environment at run time.
#
# Runs as uid/gid 10001 with a read-only root file system; writes only to /var/lib/adminforge (the PersistentVolume:
# the SQLite database and report files) and /tmp.
#
# Base images are pinned by digest, the tag kept beside it (S-37; tests/guards/image-digests.test.ts), and named
# literally in each FROM so Dependabot's docker ecosystem bumps tag and digest together:
#   node:24.13.1-bookworm-slim — the multi-platform index (linux/amd64, linux/arm64/v8, linux/ppc64le, linux/s390x),
#   looked up 2026-10-21. The image is built for the platform of the machine that builds it (README.md →
#   Requirements › CPU architecture); better-sqlite3 ships prebuilt linux-x64 and linux-arm64 binaries.
#   docker/dockerfile:1.7 (the `# syntax=` frontend) — pinned the same way.

# ── Build: install, build the four bundles, then keep production dependencies only ─────────────────────
FROM node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2 AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
      --filter @adminforge/api... --filter @adminforge/web... --filter @adminforge/cli... --filter @adminforge/scheduler...
# design-tokens first: the web app imports the tokens.css it generates.
RUN pnpm --filter @adminforge/design-tokens build \
 && pnpm --filter @adminforge/web build \
 && pnpm --filter @adminforge/api build \
 && pnpm --filter @adminforge/scheduler build \
 && pnpm --filter @adminforge/cli build
# The bundles carry the workspace packages; what stays external is the three packages' own npm dependencies. Install
# just those into empty node_modules folders (same store, no network), and keep only this platform's prebuilt
# better-sqlite3 binary.
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
 && CI=true pnpm install --frozen-lockfile --prod --offline \
      --filter @adminforge/api --filter @adminforge/cli --filter @adminforge/scheduler \
 && find node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/prebuilds -mindepth 1 -maxdepth 1 \
      ! -name "linux-$(node -p process.arch).node" -exec rm -rf {} +

# ── Runtime ───────────────────────────────────────────────────────────────────────────────────────────
FROM node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2 AS runtime
ARG ADMINFORGE_COMMIT=unknown
ARG ADMINFORGE_REVIEWED=false
RUN groupadd --gid 10001 adminforge \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /var/lib/adminforge --shell /usr/sbin/nologin adminforge \
 && install -d -o 10001 -g 10001 -m 0700 /var/lib/adminforge
WORKDIR /app
# The repository's layout, so the bundles find what they look for next to them (drizzle/, web dist, content, BUILD.json).
COPY --from=build /src/package.json /src/pnpm-workspace.yaml ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/portal/apps/api/package.json ./portal/apps/api/package.json
COPY --from=build /src/portal/apps/api/node_modules ./portal/apps/api/node_modules
COPY --from=build /src/portal/apps/api/dist ./portal/apps/api/dist
COPY --from=build /src/portal/apps/api/drizzle ./portal/apps/api/drizzle
COPY --from=build /src/portal/apps/scheduler/package.json ./portal/apps/scheduler/package.json
COPY --from=build /src/portal/apps/scheduler/node_modules ./portal/apps/scheduler/node_modules
COPY --from=build /src/portal/apps/scheduler/dist ./portal/apps/scheduler/dist
COPY --from=build /src/portal/tools/cli/package.json ./portal/tools/cli/package.json
COPY --from=build /src/portal/tools/cli/node_modules ./portal/tools/cli/node_modules
COPY --from=build /src/portal/tools/cli/dist ./portal/tools/cli/dist
COPY --from=build /src/portal/apps/web/dist ./portal/apps/web/dist
COPY --from=build /src/portal/content ./portal/content
COPY --from=build /src/config/example.env ./config/example.env
COPY portal/deploy/kubernetes/adminforge.sh /usr/local/bin/adminforge
RUN printf '{"commit":"%s","reviewed":%s,"contentDir":"portal/content"}\n' "$ADMINFORGE_COMMIT" "$ADMINFORGE_REVIEWED" \
      > /app/BUILD.json \
 && chmod 0755 /usr/local/bin/adminforge

# Configuration comes from the environment only (a Secret and the ConfigMap): no env file is read.
ENV NODE_ENV=production \
    ADMINFORGE_ENV_FILE=/dev/null \
    API_HOST=0.0.0.0 \
    API_PORT=3300 \
    DATABASE_PATH=/var/lib/adminforge/adminforge.db \
    ADMINFORGE_ARTIFACTS_DIR=/var/lib/adminforge/artifacts \
    WEB_DIST_DIR=/app/portal/apps/web/dist \
    CONTENT_SOURCE=db \
    CONTENT_DIR=/app/portal/content

USER 10001:10001
VOLUME ["/var/lib/adminforge"]
EXPOSE 3300
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3300/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "portal/apps/api/dist/main.js"]
