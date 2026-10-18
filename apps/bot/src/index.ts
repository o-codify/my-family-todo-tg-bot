import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { webhookCallback } from 'grammy';
import { bot, registerBotCommands, registerWebhook } from './bot';
import { env } from './env';
import { logger } from './logger';

/**
 * Standalone bot entry point.
 *
 * Production runs the bot *inside* the API process (one container, one
 * Node process) — see `apps/api/src/index.ts`, which mounts
 * `webhookCallback(bot, 'hono')` on the shared Hono app. This file stays
 * for local development, where running the bot on its own (long-polling)
 * is the quickest way to iterate on handlers.
 */

async function main() {
  const username = await registerBotCommands();

  if (env.TELEGRAM_WEBHOOK_URL) {
    await runWebhookMode(username);
  } else {
    await runLongPollingMode(username);
  }
}

async function runLongPollingMode(username: string | undefined) {
  logger.info({ username }, 'Bot starting (long-polling)');

  // If a webhook was previously registered (e.g. swapping prod→dev), clear
  // it now — getUpdates is rejected by Telegram while a webhook is active.
  await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => undefined);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Stopping bot...');
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await bot.start({
    onStart: (info) => logger.info({ username: info.username }, 'Bot is running'),
  });
}

async function runWebhookMode(username: string | undefined) {
  logger.info({ username, port: env.BOT_PORT }, 'Bot starting (webhook)');

  // Register the webhook on Telegram. `setWebhook` is idempotent — calling
  // it with the same URL on each restart is fine. The secret is sent back
  // as `X-Telegram-Bot-Api-Secret-Token` so we can verify the caller.
  const webhookUrl = await registerWebhook(
    env.TELEGRAM_WEBHOOK_URL,
    env.TELEGRAM_WEBHOOK_SECRET,
  );
  logger.info({ webhookUrl }, 'webhook registered');

  // grammY ships a Node http adapter via `webhookCallback`. It returns a
  // `(req, res) => void` we mount on a tiny built-in http server.
  const handle = webhookCallback(bot, 'http', {
    secretToken: env.TELEGRAM_WEBHOOK_SECRET || undefined,
  });

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mode: 'webhook' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/webhook') {
      // grammY's webhookCallback takes care of secret validation, body parse,
      // dispatch, and acks. Any unhandled errors land in bot.catch (above).
      // We wrap in a Promise.resolve to satisfy the void-return contract.
      void (handle as unknown as (req: IncomingMessage, res: ServerResponse) => Promise<void>)(req, res).catch(
        (err) => {
          logger.error({ err }, 'webhook handler threw');
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        },
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Stopping webhook server...');
    server.close();
    // Don't drop the webhook on shutdown — that would create a window where
    // Telegram sends updates to nobody. Leave it registered; the next boot
    // takes over instantly.
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await new Promise<void>((resolve) => {
    server.listen(env.BOT_PORT, env.BOT_HOST, () => {
      logger.info({ port: env.BOT_PORT, host: env.BOT_HOST }, 'webhook server listening');
      resolve();
    });
  });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
