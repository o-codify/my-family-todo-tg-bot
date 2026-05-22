import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_BOT_USERNAME: z.string().min(1),
  WEBAPP_URL: z.string().url(),
  BOT_API_BASE_URL: z.string().url(),
  INTERNAL_SERVICE_TOKEN: z.string().min(8),
  // Set TELEGRAM_WEBHOOK_URL to switch from long-polling to webhook mode.
  // The bot will bind an HTTP server on BOT_PORT and ask Telegram to POST
  // updates to {TELEGRAM_WEBHOOK_URL}/webhook. The secret token (if set)
  // is validated on every incoming request via the
  // `X-Telegram-Bot-Api-Secret-Token` header.
  TELEGRAM_WEBHOOK_URL: z.string().optional().default(''),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional().default(''),
  BOT_PORT: z.coerce.number().int().positive().default(3001),
  BOT_HOST: z.string().default('0.0.0.0'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
