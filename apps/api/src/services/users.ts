import { eq } from 'drizzle-orm';
import type { TelegramInitDataUser } from '@family-todo/tg-auth';
import { db } from '../db/client';
import { users, type UserRow } from '../db/schema';

const MEMBER_COLORS = [
  '#FF6B6B',
  '#4ECDC4',
  '#FFD93D',
  '#6BCB77',
  '#A66CFF',
  '#FF9F68',
  '#3D8BFD',
  '#E83E8C',
];

function colorFor(telegramId: number): string {
  const idx = Math.abs(Number(telegramId) % MEMBER_COLORS.length);
  return MEMBER_COLORS[idx] ?? MEMBER_COLORS[0]!;
}

export async function upsertTelegramUser(tg: TelegramInitDataUser): Promise<UserRow> {
  const tgIdBigint = BigInt(tg.id);

  const existing = await db.query.users.findFirst({
    where: eq(users.telegramId, tgIdBigint),
  });

  if (existing) {
    const needsUpdate =
      existing.firstName !== tg.firstName ||
      existing.lastName !== (tg.lastName ?? null) ||
      existing.username !== (tg.username ?? null) ||
      existing.avatarUrl !== (tg.photoUrl ?? null);

    if (!needsUpdate) return existing;

    const [updated] = await db
      .update(users)
      .set({
        firstName: tg.firstName,
        lastName: tg.lastName ?? null,
        username: tg.username ?? null,
        avatarUrl: tg.photoUrl ?? null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id))
      .returning();

    return updated!;
  }

  const [inserted] = await db
    .insert(users)
    .values({
      telegramId: tgIdBigint,
      firstName: tg.firstName,
      lastName: tg.lastName ?? null,
      username: tg.username ?? null,
      avatarUrl: tg.photoUrl ?? null,
      locale: tg.languageCode ?? 'ru',
      color: colorFor(tg.id),
    })
    .returning();

  return inserted!;
}

export function serializeUser(row: UserRow) {
  return {
    id: row.id,
    telegramId: String(row.telegramId),
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    avatarUrl: row.avatarUrl,
    locale: row.locale,
    timezone: row.timezone,
    color: row.color,
    notificationSettings: row.notificationSettings,
    awayUntil: row.awayUntil?.toISOString() ?? null,
    awayReason: (row.awayReason as 'vacation' | 'sick' | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
