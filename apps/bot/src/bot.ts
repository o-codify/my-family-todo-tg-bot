import { Bot, InlineKeyboard, webhookCallback } from 'grammy';
import {
  BotApiError,
  completeOccurrenceForChat,
  deletePhotoForChat,
  fetchTodayForUser,
  lookupInviteCode,
  snoozeOccurrenceForChat,
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

/**
 * Inline-keyboard actions on reminder messages. Callback data is
 * `occ-done:<occurrenceId>` / `occ-tomorrow:<occurrenceId>` — both
 * keep the message but strip the keyboard so the user sees the
 * outcome without an extra chat line.
 */
bot.callbackQuery(/^occ-done:(.+)$/, async (ctx) => {
  const occurrenceId = ctx.match?.[1];
  const tgId = ctx.from?.id;
  if (!occurrenceId || !tgId) {
    await ctx.answerCallbackQuery({ text: '—' });
    return;
  }
  try {
    const result = await completeOccurrenceForChat(occurrenceId, tgId);
    if (!result) {
      await ctx.answerCallbackQuery({
        text: 'Не удалось — открой задачу в приложении',
        show_alert: true,
      });
      return;
    }
    const toast =
      result.status === 'pending_approval'
        ? '⏳ Отправлено на проверку'
        : '✓ Готово';
    await ctx.answerCallbackQuery({ text: toast });
    // Strip the keyboard — the action is terminal from chat.
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch {
      // Older messages may be uneditable (>48h); ignore.
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, occurrenceId },
      'occ-done callback failed',
    );
    await ctx.answerCallbackQuery({
      text: 'Не получилось — попробуйте позже',
      show_alert: true,
    });
  }
});

bot.callbackQuery(/^occ-tomorrow:(.+)$/, async (ctx) => {
  const occurrenceId = ctx.match?.[1];
  const tgId = ctx.from?.id;
  if (!occurrenceId || !tgId) {
    await ctx.answerCallbackQuery({ text: '—' });
    return;
  }
  try {
    const result = await snoozeOccurrenceForChat(occurrenceId, tgId);
    if (!result) {
      await ctx.answerCallbackQuery({
        text: 'Не получилось перенести',
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery({
      text: result.newDate ? `⏰ На ${result.newDate}` : '⏰ Перенесено',
    });
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch {
      // 48h edit window — ignore.
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, occurrenceId },
      'occ-tomorrow callback failed',
    );
    await ctx.answerCallbackQuery({
      text: 'Не получилось — попробуйте позже',
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

/**
 * The configured bot instance.
 *
 * Exported so the API process can mount `webhookCallback(bot, 'hono')` on
 * its own Hono app — the whole stack (API + bot + Mini App) runs as one
 * process in one container. `apps/bot/src/index.ts` keeps a standalone
 * entry point for running the bot on its own during development.
 */
export { bot };

/**
 * Register the command list shown in Telegram's UI. Idempotent.
 *
 * `bot.init()` fetches and caches `getMe`. In webhook mode grammY would
 * otherwise do it lazily on the first update — doing it at boot keeps the
 * first user interaction from paying for a round-trip to Telegram.
 */
export async function registerBotCommands(): Promise<string | undefined> {
  await bot.init();
  const me = bot.botInfo;
  await bot.api.setMyCommands([
    { command: 'start', description: 'Открыть приложение' },
    { command: 'today', description: 'Задачи на сегодня' },
    { command: 'help', description: 'Помощь' },
  ]);
  return me.username;
}

/**
 * Hono handler for `POST /webhook`.
 *
 * grammY validates the `X-Telegram-Bot-Api-Secret-Token` header, parses the
 * update, dispatches it through the middleware stack above and acks — any
 * throw lands in `bot.catch`. Returned as a plain handler so the API's Hono
 * app can mount it without taking a direct dependency on grammY.
 */
export function createWebhookHandler(secretToken?: string) {
  return webhookCallback(bot, 'hono', { secretToken: secretToken || undefined });
}

/**
 * Point Telegram at `{publicUrl}/webhook`. Idempotent — calling it with the
 * same URL on every boot is the intended usage. Returns the registered URL
 * for logging.
 */
export async function registerWebhook(
  publicUrl: string,
  secretToken?: string,
): Promise<string> {
  const webhookUrl = `${publicUrl.replace(/\/+$/, '')}/webhook`;
  await bot.api.setWebhook(webhookUrl, {
    secret_token: secretToken || undefined,
    drop_pending_updates: false,
    allowed_updates: ['message', 'callback_query'],
  });
  return webhookUrl;
}
