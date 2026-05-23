import { createHmac, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { googleOauthTokens, type GoogleOauthTokenRow } from '../db/schema';
import { env } from '../env';
import { logger } from '../logger';
import { decryptToken, encryptToken, isGoogleOauthConfigured } from './google-crypto';

/**
 * Google OAuth — auth-code flow with offline access.
 *
 * State is a signed (HMAC) blob carrying the userId + a random nonce.
 * On callback we verify the signature and trust the userId — Telegram
 * initData isn't available cross-domain when Google redirects back to
 * us, so we can't re-derive the user from the request alone.
 *
 * Scopes: `calendar` — we need read/write event AND ability to create
 * a dedicated calendar (`calendar.calendars.insert`). Cleaner UX than
 * dumping into the user's primary.
 */

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** Signs a payload with HMAC-SHA256; returns `payload.sig` (base64url
 *  in both halves). State is short-lived (we time-bound it via the
 *  embedded `iat` claim — 10 minutes). */
function signState(payload: Record<string, unknown>): string {
  if (!env.GOOGLE_TOKEN_ENC_KEY) throw new Error('crypto key missing');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', env.GOOGLE_TOKEN_ENC_KEY)
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state: string): { userId: string; nonce: string } | null {
  if (!env.GOOGLE_TOKEN_ENC_KEY) return null;
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', env.GOOGLE_TOKEN_ENC_KEY)
    .update(body)
    .digest('base64url');
  // Constant-time compare not strictly needed (state is opaque to
  // attackers without the key) but cheap to do right.
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  if (diff !== 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      userId?: string;
      nonce?: string;
      iat?: number;
    };
    if (!parsed.userId || !parsed.nonce) return null;
    // 10-minute window — the OAuth flow takes at most ~30s normally.
    if (typeof parsed.iat === 'number' && Date.now() - parsed.iat > 600_000) return null;
    return { userId: parsed.userId, nonce: parsed.nonce };
  } catch {
    return null;
  }
}

export function buildAuthUrl(input: { userId: string }): string {
  if (!isGoogleOauthConfigured()) {
    throw new Error('Google OAuth is not configured');
  }
  const state = signState({
    userId: input.userId,
    nonce: randomBytes(16).toString('hex'),
    iat: Date.now(),
  });
  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI!,
    response_type: 'code',
    scope: SCOPES.join(' '),
    // `offline` + prompt=consent guarantees a refresh_token even when
    // the user has previously consented; without `prompt=consent`
    // Google returns only the access_token on subsequent connects,
    // which breaks us.
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
};

/** Exchange the auth code for tokens. Used inside the callback handler. */
export async function exchangeCode(input: {
  code: string;
  state: string;
}): Promise<{ userId: string; tokens: TokenResponse } | null> {
  if (!isGoogleOauthConfigured()) return null;
  const stateData = verifyState(input.state);
  if (!stateData) return null;
  const body = new URLSearchParams({
    code: input.code,
    client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI!,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    logger.warn({ status: res.status, text }, 'google token exchange failed');
    return null;
  }
  const tokens = (await res.json()) as TokenResponse;
  return { userId: stateData.userId, tokens };
}

/** Persist a fresh token bundle, creating or replacing the row in
 *  google_oauth_tokens. Encrypts both access + refresh. */
export async function saveTokens(input: {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scope: string;
  calendarId: string;
}): Promise<void> {
  const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
  await db
    .insert(googleOauthTokens)
    .values({
      userId: input.userId,
      accessTokenEnc: encryptToken(input.accessToken),
      refreshTokenEnc: encryptToken(input.refreshToken),
      expiresAt,
      calendarId: input.calendarId,
      scope: input.scope,
    })
    .onConflictDoUpdate({
      target: googleOauthTokens.userId,
      set: {
        accessTokenEnc: encryptToken(input.accessToken),
        refreshTokenEnc: encryptToken(input.refreshToken),
        expiresAt,
        calendarId: input.calendarId,
        scope: input.scope,
        updatedAt: new Date(),
      },
    });
}

export async function getTokenRow(
  userId: string,
): Promise<GoogleOauthTokenRow | null> {
  const row = await db.query.googleOauthTokens.findFirst({
    where: eq(googleOauthTokens.userId, userId),
  });
  return row ?? null;
}

/**
 * Returns a valid access token, refreshing if it's close to expiry
 * (within 5 minutes). Updates the row in place. Returns null when
 * the user is not connected or the refresh fails (likely revoked).
 */
export async function getValidAccessToken(userId: string): Promise<string | null> {
  const row = await getTokenRow(userId);
  if (!row) return null;
  // 5-minute slack — Google's clocks and ours might drift, and we'd
  // rather refresh a bit early than fire a doomed request.
  if (row.expiresAt.getTime() - Date.now() > 5 * 60_000) {
    return decryptToken(row.accessTokenEnc);
  }
  const refreshed = await refreshAccessToken(row);
  return refreshed;
}

async function refreshAccessToken(
  row: GoogleOauthTokenRow,
): Promise<string | null> {
  if (!isGoogleOauthConfigured()) return null;
  const refreshToken = decryptToken(row.refreshTokenEnc);
  const body = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    logger.warn({ status: res.status, text }, 'google token refresh failed');
    // 400 invalid_grant means refresh token revoked — drop the row so
    // the user is prompted to reconnect.
    if (res.status === 400) {
      await db
        .delete(googleOauthTokens)
        .where(eq(googleOauthTokens.userId, row.userId));
    }
    return null;
  }
  const tokens = (await res.json()) as TokenResponse;
  const newAccess = tokens.access_token;
  const newExpires = new Date(Date.now() + tokens.expires_in * 1000);
  await db
    .update(googleOauthTokens)
    .set({
      accessTokenEnc: encryptToken(newAccess),
      expiresAt: newExpires,
      updatedAt: new Date(),
    })
    .where(eq(googleOauthTokens.userId, row.userId));
  return newAccess;
}

/** Revoke + delete. Best-effort: even if the Google revoke call fails
 *  (network, already-revoked), we still drop the row locally so the
 *  next "Connect" press starts a fresh flow. */
export async function disconnect(userId: string): Promise<boolean> {
  const row = await getTokenRow(userId);
  if (!row) return false;
  const refreshToken = decryptToken(row.refreshTokenEnc);
  try {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(refreshToken)}`, {
      method: 'POST',
    });
  } catch (err) {
    logger.warn({ err }, 'google revoke threw — proceeding to drop local row');
  }
  await db.delete(googleOauthTokens).where(eq(googleOauthTokens.userId, userId));
  return true;
}
