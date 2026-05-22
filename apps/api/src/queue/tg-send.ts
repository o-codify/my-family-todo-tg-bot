import { env } from '../env';
import { logger } from '../logger';

/**
 * Bare-bones Telegram Bot API `sendMessage` wrapper. We don't depend on the
 * photo service's `tgCall` because photos throw `PhotoServiceError` — for
 * notifications we want a generic "could the message go out" answer.
 *
 * Returns `true` on success. Logs and returns `false` on Telegram-side
 * rejection (most often: user blocked the bot, or hasn't pressed /start).
 */
export async function sendBotMessage(input: {
  chatId: number;
  text: string;
  parseMode?: 'HTML' | 'MarkdownV2';
}): Promise<boolean> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text,
        parse_mode: input.parseMode,
        disable_web_page_preview: true,
      }),
    });
    const json = (await res.json()) as { ok: boolean; description?: string };
    if (!json.ok) {
      logger.warn(
        { chatId: input.chatId, description: json.description },
        'Telegram sendMessage rejected',
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, chatId: input.chatId }, 'Telegram sendMessage threw');
    return false;
  }
}
