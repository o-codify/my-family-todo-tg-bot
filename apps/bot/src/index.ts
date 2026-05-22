import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Bot, InlineKeyboard, webhookCallback } from 'grammy';
import {
  BotApiError,
  deletePhotoForChat,
  fetchTodayForUser,
  lookupInviteCode,
} from './api-client';
import { env } from './env';
import { logger } from './logger';

const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

const INVITE_CODE_RE = /^[A-Z0-9]{4,32}$/;

function buildWebAppUrl(startParam?: string): string {
  if (!startParam) return env.WEBAPP_URL;
  const url = new URL(env.WEBAPP_URL);
  url.searchParams.set('tgWebAppStartParam', startParam);
  return url.toString();
}

bot.command('start', async (ctx) => {
  const payload = ctx.match?.trim();
  const candidate = payload?.toUpperCase();
  const isInviteShape = candidate && INVITE_CODE_RE.test(candidate);

  if (isInviteShape) {
    try {
      const family = await lookupInviteCode(candidate);
      if (!family) {
        await ctx.reply(
          `Код <code>${candidate}</code> не найден.\n\nПопросите владельца семьи прислать актуальную ссылку.`,
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard().webApp(
              'Открыть приложение',
              buildWebAppUrl(),
            ),
          },
        );
        return;
      }

      await ctx.reply(
        [
          `Приглашение в семью <b>${escapeHtml(family.name)}</b>.`,
          '',
          'Откройте приложение, чтобы войти.',
        ].join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().webApp(
            'Войти в семью',
            buildWebAppUrl(family.inviteCode),
          ),
        },
      );
      return;
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, 'Failed to look up invite');
      const isApiDown = err instanceof BotApiError || (err instanceof Error && /fetch/i.test(err.message));
      await ctx.reply(
        isApiDown
          ? 'Сервис временно недоступен, попробуйте через минуту.'
          : 'Не удалось проверить код. Попробуйте ещё раз.',
        {
          reply_markup: new InlineKeyboard().webApp(
            'Открыть приложение',
            buildWebAppUrl(candidate),
          ),
        },
      );
      return;
    }
  }

  await ctx.reply(
    [
      'Привет! Это бот семейного списка задач.',
      '',
      'Откройте приложение, чтобы создать или войти в семью.',
    ].join('\n'),
    {
      reply_markup: new InlineKeyboard().webApp('Открыть приложение', buildWebAppUrl()),
    },
  );
});

bot.command('today', async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) {
    await ctx.reply('Не удалось определить пользователя.');
    return;
  }
  try {
    const data = await fetchTodayForUser(tgId);
    if (!data) {
      await ctx.reply(
        'Сначала откройте приложение, чтобы создать профиль.',
        {
          reply_markup: new InlineKeyboard().webApp('Открыть приложение', buildWebAppUrl()),
        },
      );
      return;
    }
    const isEn = data.locale === 'en';
    if (data.tasks.length === 0) {
      await ctx.reply(
        isEn ? `🎉 Nothing scheduled for ${data.date} — enjoy.` : `🎉 На ${data.date} ничего нет — отдыхай.`,
      );
      return;
    }
    const header = isEn ? `☀️ Today (${data.date}):` : `☀️ На сегодня (${data.date}):`;
    // Only tag each line with the family name when the user actually has
    // more than one family — otherwise it's noise ("1. И · +40 · Цц"
    // when the user is in exactly one family called Цц).
    const familyNames = new Set(data.tasks.map((t) => t.familyName));
    const showFamily = familyNames.size > 1;
    const lines = data.tasks.map((t, i) => {
      const time = t.time ? ` · ${t.time.slice(0, 5)}` : '';
      const pts = t.points > 0 ? ` · +${t.points}` : '';
      const fam = showFamily ? ` <i>· ${escapeHtml(t.familyName)}</i>` : '';
      return `${i + 1}. ${escapeHtml(t.title)}${time}${pts}${fam}`;
    });
    await ctx.reply([header, ...lines].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().webApp(
        isEn ? 'Open app' : 'Открыть приложение',
        buildWebAppUrl(),
      ),
    });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, '/today failed');
    await ctx.reply('Не удалось получить список. Попробуйте позже.');
  }
});

/**
 * Inline callback handler for the "🗑 Удалить фото" button under task-photo
 * messages we send from the API. Callback data shape: `delphoto:<photoId>`.
 * On success we strip the keyboard and rewrite the caption so the user sees
 * confirmation in-chat (the API already deletes the photo row server-side).
 */
bot.callbackQuery(/^delphoto:(.+)$/, async (ctx) => {
  const photoId = ctx.match?.[1];
  const tgId = ctx.from?.id;
  if (!photoId || !tgId) {
    await ctx.answerCallbackQuery({ text: 'Не удалось определить фото', show_alert: false });
    return;
  }
  try {
    const ok = await deletePhotoForChat(photoId, tgId);
    if (!ok) {
      await ctx.answerCallbackQuery({
        text: 'Фото уже удалено или больше не доступно',
      });
      return;
    }
    // The API's `deletePhoto` already tries `deleteMessage` first. If that
    // succeeded the message is gone; if it didn't (older than 48h, etc.),
    // it falls back to editing caption + clearing the keyboard. Either way
    // there's nothing more for us to do besides answering the callback so
    // the spinner stops in the user's chat.
    await ctx.answerCallbackQuery({ text: '🗑 Удалено' });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, photoId }, 'Failed to delete photo');
    await ctx.answerCallbackQuery({
      text: 'Не удалось удалить, попробуйте позже',
      show_alert: true,
    });
  }
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    [
      '/start — открыть приложение',
      '/start <код> — войти в семью по приглашению',
      '/today — задачи на сегодня',
      '/help — это сообщение',
    ].join('\n'),
  );
});

bot.catch((err) => {
  logger.error({ err }, 'Bot error');
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function main() {
  const me = await bot.api.getMe();
  await bot.api.setMyCommands([
    { command: 'start', description: 'Открыть приложение' },
    { command: 'today', description: 'Задачи на сегодня' },
    { command: 'help', description: 'Помощь' },
  ]);

  if (env.TELEGRAM_WEBHOOK_URL) {
    await runWebhookMode(me.username);
  } else {
    await runLongPollingMode(me.username);
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
  const publicUrl = env.TELEGRAM_WEBHOOK_URL.replace(/\/+$/, '');
  const webhookUrl = `${publicUrl}/webhook`;
  logger.info({ username, webhookUrl, port: env.BOT_PORT }, 'Bot starting (webhook)');

  // Register the webhook on Telegram. `setWebhook` is idempotent — calling
  // it with the same URL on each restart is fine. The secret is sent back
  // as `X-Telegram-Bot-Api-Secret-Token` so we can verify the caller.
  await bot.api.setWebhook(webhookUrl, {
    secret_token: env.TELEGRAM_WEBHOOK_SECRET || undefined,
    drop_pending_updates: false,
    allowed_updates: ['message', 'callback_query'],
  });

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
