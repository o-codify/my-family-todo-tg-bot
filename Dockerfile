# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────────────
# family-todo — single production image.
#
# One image, one container, one Node process holding all three pieces:
#   * the HTTP API            (Hono)            → /api/*, /health
#   * the Telegram bot        (grammY webhook)  → /webhook
#   * the Mini App bundle     (Vite, static)    → everything else
#
# Build from the monorepo root:
#   docker build -t family-todo \
#     --build-arg VITE_API_BASE_URL=https://my-family-todo.example.com \
#     --build-arg VITE_TG_BOT_USERNAME=mybot .
#
# Vite inlines its env at build time, so the two VITE_* values must come
# in as --build-arg; everything else is read from the environment at boot.
#
# Size strategy — the previous per-service images shipped the whole
# monorepo node_modules (typescript, vite, vitest, drizzle-kit, turbo,
# esbuild/rollup binaries…) into the runtime layer. Here the runtime only
# receives a node_modules tree resolved from scratch with `--prod`, plus
# the four `dist/` outputs. Nothing else crosses over from the build.
# ─────────────────────────────────────────────────────────────────────

# ── base ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
ENV CI=true

# ── deps: manifests only, so the layer caches until a package.json moves
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/bot/package.json apps/bot/
COPY apps/miniapp/package.json apps/miniapp/
COPY packages/shared/package.json packages/shared/
COPY packages/tg-auth/package.json packages/tg-auth/
COPY packages/config/package.json packages/config/
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

# ── build: compile everything (needs the dev deps from `deps`)
FROM deps AS build
ARG VITE_API_BASE_URL
ARG VITE_TG_BOT_USERNAME
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_TG_BOT_USERNAME=${VITE_TG_BOT_USERNAME}
COPY . .
RUN pnpm --filter @family-todo/shared build && \
    pnpm --filter @family-todo/tg-auth build && \
    pnpm --filter @family-todo/bot build && \
    pnpm --filter @family-todo/api build && \
    pnpm --filter @family-todo/miniapp build && \
    node scripts/precompress.mjs apps/miniapp/dist

# ── prod-deps: same lockfile, resolved without devDependencies ────────
# Deliberately built from `base`, NOT from `deps`: pnpm prunes its virtual
# store (node_modules/.pnpm) only on a full-workspace install, so re-running
# it over the dev tree leaves typescript, turbo, esbuild & co. behind.
# Installing into an empty node_modules is the only way to get a genuinely
# prod-only store.
#
# The miniapp is filtered out — its deps are bundled into the static output
# at build time and are never loaded at runtime.
FROM base AS proddeps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/bot/package.json apps/bot/
COPY apps/miniapp/package.json apps/miniapp/
COPY packages/shared/package.json packages/shared/
COPY packages/tg-auth/package.json packages/tg-auth/
COPY packages/config/package.json packages/config/
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --prod --ignore-scripts \
      --filter @family-todo/api \
      --filter @family-todo/bot \
      --filter @family-todo/shared \
      --filter @family-todo/tg-auth && \
    rm -rf node_modules/.pnpm/typescript@* \
           node_modules/.pnpm/@types+* \
           node_modules/.pnpm/csstype@*
# ^ pnpm auto-installs peer dependencies, and two runtime deps declare
#   type-only peers: valibot (via @telegram-apps/init-data-node) wants
#   typescript — 23 MB by itself — and drizzle-orm wants @types/react.
#   Neither is ever require()d at runtime. This has to happen inside the
#   install layer: deleting them in the runner would only hide them, the
#   bytes would still ship in the copied layer.

# ── runner ───────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Nothing at runtime shells out to a package manager; npm + corepack are
# ~20 MB of the base image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/lib/node_modules/corepack /usr/local/bin/corepack /opt/yarn*

# pnpm keeps real packages in ./node_modules/.pnpm and leaves relative
# symlinks in each workspace's own node_modules. Those links only resolve
# if the /app layout is preserved, so copy the tree piece by piece rather
# than flattening it.
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=proddeps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=proddeps /app/apps/bot/node_modules ./apps/bot/node_modules
COPY --from=proddeps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=proddeps /app/packages/tg-auth/node_modules ./packages/tg-auth/node_modules

# pnpm auto-installs peer dependencies, and two runtime deps declare
# type-only peers: valibot (via @telegram-apps/init-data-node) wants
# typescript — 23 MB on its own — and drizzle-orm wants @types/react.
# Neither is ever require()d at runtime; the dangling symlinks they leave
# behind are only followed by a type checker, which never runs in here.
RUN rm -rf node_modules/.pnpm/typescript@*            node_modules/.pnpm/@types+*            node_modules/.pnpm/csstype@*

# Manifests: Node needs them to resolve the `exports` maps of the
# workspace packages (`@family-todo/shared`, `@family-todo/bot/bot`, …).
COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/bot/package.json apps/bot/
COPY packages/shared/package.json packages/shared/
COPY packages/tg-auth/package.json packages/tg-auth/

# Compiled output.
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/tg-auth/dist ./packages/tg-auth/dist
COPY --from=build /app/apps/bot/dist ./apps/bot/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
# Drizzle reads the .sql files at boot; they live next to the TS sources,
# not in dist/ (see resolveMigrationsFolder in src/db/migrate.ts).
COPY --from=build /app/apps/api/src/db/migrations ./apps/api/src/db/migrations
# The Mini App bundle, served by the API process (see MINIAPP_DIST).
COPY --from=build /app/apps/miniapp/dist ./apps/miniapp/dist

USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
