# Deployment guide

This stack runs as four containers:

| Service | What it does | Public? |
|---|---|---|
| `postgres` | Drizzle migrations + data | no (internal) |
| `redis` | BullMQ jobs + SSE pub/sub | no (internal) |
| `api` | Hono backend + worker | **yes** — Mini App calls it |
| `bot` | grammY bot (long-poll or webhook) | webhook mode only |
| `miniapp` | nginx serving the static Vite bundle | **yes** — opened by Telegram WebApp |

All three app containers are built from in-repo `Dockerfile`s at
`apps/{api,bot,miniapp}/Dockerfile`. Build context is the **monorepo root**
so workspace deps resolve.

## Prereqs

- A public HTTPS hostname for the Mini App (Telegram requires HTTPS).
- A public HTTPS hostname for the API (Mini App fetches from here).
- For webhook bot mode: a public HTTPS endpoint that points at the bot
  container's `:3001`. Same hostname as the API is fine if you reverse-
  proxy by path.
- Docker 24+ with the `compose` plugin.

## Setup

1. Clone the repo to the host.
2. Copy `.env.example` → `.env` and fill in the prod values:
   ```
   POSTGRES_PASSWORD=<random>
   INTERNAL_SERVICE_TOKEN=<random 32+ chars>
   TELEGRAM_BOT_TOKEN=<from BotFather>
   TELEGRAM_BOT_USERNAME=<your bot username, no @>
   WEBAPP_URL=https://miniapp.example.com
   API_PUBLIC_URL=https://api.example.com
   CORS_ORIGINS=https://miniapp.example.com
   VITE_API_BASE_URL=https://api.example.com
   VITE_TG_BOT_USERNAME=<your bot username>
   # For webhook mode, set both:
   TELEGRAM_WEBHOOK_URL=https://bot.example.com
   TELEGRAM_WEBHOOK_SECRET=<random>
   ```
3. Build + start:
   ```sh
   docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml up -d --build
   ```
4. Run the migration once:
   ```sh
   docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml \
     --profile tools run --rm migrate
   ```
5. Point your reverse proxy (Coolify, Caddy, nginx, Traefik …) at:
   - `api.example.com` → `api:3000`
   - `miniapp.example.com` → `miniapp:80`
   - `bot.example.com` → `bot:3001` (webhook mode only)
6. In BotFather, set the WebApp URL to `https://miniapp.example.com`.

## Updates

Pull, rebuild, restart. The migration service is idempotent:

```sh
git pull
docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml build
docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml \
  --profile tools run --rm migrate
docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml up -d
```

## Notes

- **No S3 / object store.** Photos go to Telegram (see
  `docs/tech-plan.md` §9). Postgres + Redis are the only stateful pieces.
- **Webhook secret token** is validated by grammY's webhook adapter — set
  `TELEGRAM_WEBHOOK_SECRET` to a random string and Telegram will echo it
  back in the `X-Telegram-Bot-Api-Secret-Token` header on every update.
- **API is single-instance** today. The BullMQ worker is in-process. If
  you scale the API horizontally, gate the worker startup with an
  env-conditional and run it as a separate container (the queue code
  already supports that).
- **Database backups** are your problem — set up `pg_dump` on a cron or
  use the Postgres volume in a managed snapshot loop.

## Local prod-style test (without Telegram)

The Mini App and API can run from this stack against a fake bot token —
the bot container will fail to register a webhook and exit, but the API
and Mini App will still come up so you can poke at them with a browser.
