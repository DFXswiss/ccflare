# syntax=docker/dockerfile:1.7
#
# ccflare server container
#
# Multi-stage build:
#   1. base    – pinned bun base image, workdir scaffolding
#   2. deps    – `bun install` against just the manifests (great layer cache)
#   3. build   – copy source, build the browser dashboard
#   4. runtime – minimal image containing only what the server needs at runtime
#
# Notes:
#   * Server entrypoint is `apps/server/src/server.ts`, which bootstraps
#     `@ccflare/runtime-server`. At startup the runtime resolves
#     `@ccflare/web/manifest.json` -> `apps/web/dist/manifest.json`, so the
#     dashboard build artefacts must exist inside the image.
#   * We do NOT build the TUI binary – the container only runs the HTTP server.
#   * Runs as root on purpose: bind-mounted state on dfx01 is owned by `dfx01`
#     and we want to avoid uid/gid mismatches for the first containerised
#     iteration. Lock this down in a follow-up once the persistent state path
#     stabilises.

ARG BUN_VERSION=1.3.14

############################
# Stage 1 – base
############################
FROM oven/bun:${BUN_VERSION}-slim AS base
WORKDIR /app

############################
# Stage 2 – deps
############################
FROM base AS deps

# Copy only the files needed to resolve the workspace graph + install deps.
# This keeps `bun install` cached across changes to source files.
COPY package.json bun.lock tsconfig.json ./
COPY apps/server/package.json     apps/server/package.json
COPY apps/web/package.json        apps/web/package.json
COPY apps/tui/package.json        apps/tui/package.json
COPY apps/desktop/package.json    apps/desktop/package.json
COPY apps/lander/package.json     apps/lander/package.json
COPY packages/api/package.json            packages/api/package.json
COPY packages/config/package.json         packages/config/package.json
COPY packages/core/package.json           packages/core/package.json
COPY packages/database/package.json       packages/database/package.json
COPY packages/http/package.json           packages/http/package.json
COPY packages/logger/package.json         packages/logger/package.json
COPY packages/oauth-flow/package.json     packages/oauth-flow/package.json
COPY packages/providers/package.json      packages/providers/package.json
COPY packages/proxy/package.json          packages/proxy/package.json
COPY packages/runtime-server/package.json packages/runtime-server/package.json
COPY packages/types/package.json          packages/types/package.json
COPY packages/ui/package.json             packages/ui/package.json

RUN bun install --frozen-lockfile

############################
# Stage 3 – build
############################
FROM deps AS build

# Copy the rest of the source tree
COPY . .

# Build the browser dashboard (writes to apps/web/dist/ which the runtime
# resolves via the `@ccflare/web/manifest.json` package export).
RUN bun run build:dashboard

############################
# Stage 4 – runtime
############################
FROM base AS runtime

ENV NODE_ENV=production \
    PORT=8080

# Workspace manifests + lockfile so bun can resolve workspace package exports.
COPY --from=build /app/package.json                      ./package.json
COPY --from=build /app/bun.lock                          ./bun.lock
COPY --from=build /app/tsconfig.json                     ./tsconfig.json

# Application source
COPY --from=build /app/apps/server                       ./apps/server
COPY --from=build /app/apps/web/package.json             ./apps/web/package.json
COPY --from=build /app/apps/web/dist                     ./apps/web/dist
COPY --from=build /app/packages                          ./packages

# Production node_modules (workspace symlinks resolved against the layout above)
COPY --from=build /app/node_modules                      ./node_modules

EXPOSE 8080

# Bun is preinstalled in the base image and ships with `fetch`, so we don't
# need curl/wget for the healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/stats').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["bun", "run", "apps/server/src/server.ts"]
