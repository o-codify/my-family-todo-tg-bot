# Deployment guide

The stack runs as **three** containers:

| Service | What it does | Public? |
|---|---|---|
| `postgres` | Drizzle migrations + data | no (internal) |
| `redis` | BullMQ jobs + SSE pub/sub | no (internal) |
| `app` | API + Telegram bot + Mini App, one Node process | **yes** |

Everything the user ever touches lives in a single image, built from the
`Dockerfile` at the **monorepo root** (build context is the root too, so
workspace deps resolve). Inside that one process:

| Path | Handled by |
|---|---|
| `/health` | API health probe |
| `/api/v1/**`, `/api/internal/v1/**` | Hono API routers |
| `/webhook` | grammY, mounted only when `TELEGRAM_WEBHOOK_URL` is set |
| everything else | the built Mini App bundle (`MINIAPP_DIST`) |

One container means one hostname, one TLS certificate and one reverse-proxy
rule. It also means the Mini App and the API share an origin, so there are
no cross-origin preflights on normal traffic.

## Prereqs

- One public HTTPS hostname (Telegram requires HTTPS for both the Mini App
  and the webhook).
- Docker 24+ with the `compose` plugin, or any runtime that can pull
  `ghcr.io/<owner>/family-todo:latest`.

## Setup

1. Clone the repo to the host.
2. Copy `.env.example` → `.env` and fill in the prod values:
   ```
   POSTGRES_PASSWORD=<random>
   INTERNAL_SERVICE_TOKEN=<random 32+ chars>
   TELEGRAM_BOT_TOKEN=<from BotFather>
   TELEGRAM_BOT_USERNAME=<your bot username, no @>
   WEBAPP_URL=https://app.example.com
   API_PUBLIC_URL=https://app.example.com
   CORS_ORIGINS=https://app.example.com
   VITE_API_BASE_URL=https://app.example.com
   VITE_TG_BOT_USERNAME=<your bot username>
   # Setting this is what boots the bot inside the API process:
   TELEGRAM_WEBHOOK_URL=https://app.example.com
   TELEGRAM_WEBHOOK_SECRET=<random>
   ```
   `VITE_*` are inlined into the JS bundle by Vite at **build** time —
   changing them requires rebuilding the image, not restarting it.
3. Build + start:
   ```sh
   docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml up -d --build
   ```
   Migrations run automatically during boot, behind a Postgres advisory
   lock. There is no separate migrate step.
4. Point your reverse proxy (Coolify, Caddy, nginx, Traefik …) at
   `app:3000` for `app.example.com` — the whole host, no path rules.
5. In BotFather, set the WebApp URL to `https://app.example.com`.

## Updates

Pull, rebuild, restart:

```sh
git pull
docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml up -d --build
```

In CI this is the `family-todo` GitHub workflow: it builds the root
Dockerfile, pushes `ghcr.io/<owner>/family-todo:{latest,YYYY.MDD.N}` and
pokes the Coolify deploy webhook (`COOLIFY_WEBHOOK` secret).

## Notes

- **Image size.** The runtime layer gets a `node_modules` tree resolved
  from scratch with `pnpm install --prod` — the build toolchain
  (typescript, vite, turbo, drizzle-kit, esbuild…) never crosses over
  from the build stage. ~300 MB uncompressed, most of which is the Node
  base image itself.
- **Static compression.** `scripts/precompress.mjs` writes `.br`/`.gz`
  siblings next to the Vite output at build time, and serveStatic picks
  them up (`precompressed: true`). That's what replaced nginx's
  on-the-fly gzip.
- **No S3 / object store.** Photos go to Telegram (see
  `docs/tech-plan.md` §9). Postgres + Redis are the only stateful pieces.
- **Webhook secret token** is validated by grammY's webhook adapter — set
  `TELEGRAM_WEBHOOK_SECRET` to a random string and Telegram will echo it
  back in the `X-Telegram-Bot-Api-Secret-Token` header on every update.
- **Single instance.** The BullMQ worker and the webhook handler are both
  in-process. If you ever scale horizontally, Telegram will deliver each
  update to exactly one replica (fine), but you'll want to gate the
  worker startup with an env flag so only one replica runs it.
- **Database backups** are your problem — set up `pg_dump` on a cron or
  use the Postgres volume in a managed snapshot loop.

## Running the bot on its own

`apps/bot` still has a standalone entry point (`apps/bot/src/index.ts`).
With `TELEGRAM_WEBHOOK_URL` unset it long-polls, which is what local dev
uses; with it set it binds its own HTTP server on `BOT_PORT`. Neither is
used in production — there the API process owns the bot.
