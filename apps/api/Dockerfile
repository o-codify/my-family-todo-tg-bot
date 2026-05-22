# syntax=docker/dockerfile:1.7

# Production image for the API process.
#
# Build context: the *monorepo root*. Run as:
#   docker build -f apps/api/Dockerfile -t family-todo-api .
#
# Multi-stage to keep the runtime image small:
#   1. base    — Node + pnpm
#   2. deps    — copy workspace manifests and install all deps (cached)
#   3. build   — copy sources and compile TS → dist/
#   4. runner  — copy node_modules + compiled output only

# ── 1. base ───────────────────────────────────────────────────────────
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ── 2. deps ───────────────────────────────────────────────────────────
# Copy only manifests first so the layer caches as long as deps don't change.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/tg-auth/package.json packages/tg-auth/
COPY packages/config/package.json packages/config/
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

# ── 3. build ──────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN pnpm --filter @family-todo/shared build && \
    pnpm --filter @family-todo/tg-auth build && \
    pnpm --filter @family-todo/api build

# ── 4. runner ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production

# pnpm workspaces keep deps in per-package node_modules (symlinks into the
# shared ./node_modules/.pnpm/<pkg>@<ver> store). Copying just /app/node_modules
# misses apps/api/node_modules where hono / drizzle / etc. live as symlinks.
# Copy the whole app + the shared store so Node's resolver finds everything.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api

EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
