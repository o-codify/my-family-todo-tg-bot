import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../env';

/**
 * AES-256-GCM token encryption. We store refresh tokens — which Google
 * gives us once and never again — so a DB leak would otherwise mean
 * permanent calendar access for an attacker. Encrypting at rest is the
 * minimum bar.
 *
 * Format: base64(IV || authTag || ciphertext). IV is 12 bytes, authTag
 * is 16 bytes. Key is 32 bytes (256 bits), loaded from env as 64 hex
 * chars; if the env is unset the helpers throw — callers should gate
 * the entire OAuth feature on `isGoogleOauthConfigured()`.
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function key(): Buffer {
  if (!env.GOOGLE_TOKEN_ENC_KEY) {
    throw new Error('GOOGLE_TOKEN_ENC_KEY is not configured');
  }
  return Buffer.from(env.GOOGLE_TOKEN_ENC_KEY, 'hex');
}

export function isGoogleOauthConfigured(): boolean {
  return Boolean(
    env.GOOGLE_OAUTH_CLIENT_ID &&
      env.GOOGLE_OAUTH_CLIENT_SECRET &&
      env.GOOGLE_OAUTH_REDIRECT_URI &&
      env.GOOGLE_TOKEN_ENC_KEY,
  );
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptToken(encoded: string): string {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('token blob too short');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
