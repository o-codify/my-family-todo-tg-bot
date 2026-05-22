# syntax=docker/dockerfile:1.7

# Production image for the Mini App static bundle. Built with Vite, served
# by nginx. Build context: monorepo root.
#   docker build -f apps/miniapp/Dockerfile \
#                --build-arg VITE_API_BASE_URL=https://api.example.com \
#                --build-arg VITE_TG_BOT_USERNAME=mybot \
#                -t family-todo-miniapp .
#
# Vite bakes env vars in at build time, so they must be passed as
# `--build-arg`, not docker-compose `environment:`.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/miniapp/package.json apps/miniapp/
COPY packages/shared/package.json packages/shared/
COPY packages/tg-auth/package.json packages/tg-auth/
COPY packages/config/package.json packages/config/
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

FROM deps AS build
ARG VITE_API_BASE_URL
ARG VITE_TG_BOT_USERNAME
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_TG_BOT_USERNAME=${VITE_TG_BOT_USERNAME}
COPY . .
# Vite bundles workspace packages from source `.ts` directly (see
# vite.config.ts `resolve.conditions: ['development']`), so no need to
# pre-build @family-todo/shared.
RUN pnpm --filter @family-todo/miniapp build

# ── nginx runtime ────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runner
# SPA fallback — every unknown route serves index.html so the hash-router
# survives a hard reload. Also caches static assets aggressively.
COPY apps/miniapp/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/miniapp/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
