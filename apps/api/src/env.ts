import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  API_PUBLIC_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  INTERNAL_SERVICE_TOKEN: z.string().min(8),
  CORS_ORIGINS: z.string().default(''),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_BOT_USERNAME: z.string().min(1),
  WEBAPP_URL: z.string().url(),
  // Photos are stored in Telegram, not S3 — the API uploads to the user's
  // private bot chat via `sendPhoto` and keeps only the file_id + message_id.
  PHOTO_MAX_SIZE_BYTES: z.coerce.number().int().positive().default(10_485_760), // 10MB Telegram limit
  PHOTO_MAX_COUNT_PER_OCCURRENCE: z.coerce.number().int().positive().default(3),
  PHOTO_ALLOWED_MIME: z.string().default('image/jpeg,image/png,image/webp'),
  // Google Calendar OAuth — optional. When unset the connect endpoints
  // return 503 instead of crashing the API. The encryption key is
  // 64 hex chars (32 bytes for AES-256-GCM); generate with
  // `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  GOOGLE_TOKEN_ENC_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 64-char hex (32 bytes)')
    .optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
