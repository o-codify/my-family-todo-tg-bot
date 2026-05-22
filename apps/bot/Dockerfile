# syntax=docker/dockerfile:1.7

# Production image for the bot process. Same shape as apps/api/Dockerfile.
# Build context: monorepo root.
#   docker build -f apps/bot/Dockerfile -t family-todo-bot .

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/bot/package.json apps/bot/
COPY packages/shared/package.json packages/shared/
COPY packages/tg-auth/package.json packages/tg-auth/
COPY packages/config/package.json packages/config/
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# shared package emits to dist/ (its `default` exports condition). Bot
# imports `@family-todo/shared`; without a JS build Node can't load it at
# runtime since the source is .ts.
RUN pnpm --filter @family-todo/shared build && \
    pnpm --filter @family-todo/bot build

FROM node:22-alpine AS runner
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production

# pnpm workspaces keep deps in per-package node_modules (symlinks into the
# shared ./node_modules/.pnpm/<pkg>@<ver> store). Copying just /app/node_modules
# misses apps/bot/node_modules where grammy & friends actually live as
# symlinks. Copy the whole app + the shared store so resolution works.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/bot ./apps/bot

# Optional — only used in webhook mode. Long-polling doesn't bind a port.
EXPOSE 3001
CMD ["node", "apps/bot/dist/index.js"]
