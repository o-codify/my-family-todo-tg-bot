import { and, desc, eq, gte, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  familyEvents,
  familyMembers,
  families,
  notificationsLog,
  roles,
  taskOccurrences,
  tasks,
  users,
} from '../db/schema';
import { daysUntil } from '../services/events';
import { logger } from '../logger';
import { getNotificationsQueue } from './index';
import { localDate, localHHMM, isInQuietHours } from './quiet-hours';
import { sendBotMessage } from './tg-send';

/**
 * Build the digest job id from a user — used as the BullMQ "repeat key" so we
 * can replace it cleanly when the user's digestTime changes. BullMQ derives
 * its own opaque key from the repeat options, but the `jobId` is ours to
 * choose, and repeat-by-cron jobs with the same jobId are deduped.
 */
function repeatJobIdForUser(userId: string): string {
  return `digest:${userId}`;
}

/**
 * Build a cron string for the user's local digestTime in their timezone. The
 * BullMQ `repeat.tz` option does the heavy lifting — we just pass HH:MM.
 */
function cronForHHMM(hhmm: string): string {
  const [h, m] = hhmm.split(':').map((s) => String(Number(s)));
  return `${m} ${h} * * *`;
}

/**
 * Idempotent re-schedule for one user. Call this:
 *  - on first sign-in (initial schedule)
 *  - whenever the user's `notificationSettings.digestTime`, `digestEnabled`,
 *    or `timezone` changes
 *
 * The producer removes the old repeatable definition and (if enabled) adds
 * a fresh one. Safe to call on every settings PATCH — costs one Redis call
 * when nothing changed.
 */
export async function rescheduleDigestForUser(input: {
  userId: string;
  digestEnabled: boolean;
  digestTime: string;
  timezone: string;
}): Promise<void> {
  const queue = getNotificationsQueue();
  const repeatJobId = repeatJobIdForUser(input.userId);

  // Remove by id (no-op if not present). Cheaper than enumerating
  // `getJobSchedulers()` — we know our own id.
  await queue.removeJobScheduler(repeatJobId).catch(() => undefined);

  if (!input.digestEnabled) {
    logger.debug({ userId: input.userId }, 'digest disabled — not scheduling');
    return;
  }

  await queue.upsertJobScheduler(
    repeatJobId,
    {
      pattern: cronForHHMM(input.digestTime),
      tz: input.timezone,
    },
    {
      name: 'digest',
      data: { userId: input.userId, forDate: '' /* worker fills in */ } satisfies {
        userId: string;
        forDate: string;
      },
    },
  );
  logger.info(
    { userId: input.userId, digestTime: input.digestTime, tz: input.timezone },
    'digest job (re)scheduled',
  );
}

/**
 * Renders + sends one user's morning digest. Worker entry point.
 *
 * Idempotency: we insert into `notifications_log` with
 *   dedupe_key = `digest:<userId>:<localDate>`
 * before sending. If the insert fails on the unique index, we treat it as
 * "already sent today" and exit silently.
 *
 * Quiet hours: if the user's quiet window covers their digestTime, we skip.
 * That's intentional — digests fire at a user-chosen hour, so the user
 * controls overlap explicitly via their settings.
 */
export async function runDigest(input: { userId: string }): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, input.userId) });
  if (!user) {
    logger.warn({ userId: input.userId }, 'digest skipped: user not found');
    return;
  }

  const today = localDate(user.timezone);
  const dedupeKey = `digest:${user.id}:${today}`;

  // Quiet-hours guard. We allow the user to opt out per send; the dedupe
  // log still records the skipped attempt so re-tries don't fire it later.
  const settings = user.notificationSettings;
  const quiet = isInQuietHours({
    start: settings.quietHoursStart,
    end: settings.quietHoursEnd,
    nowLocal: localHHMM(user.timezone),
  });
  if (quiet) {
    logger.debug({ userId: user.id }, 'digest skipped: quiet hours');
    // Still mark as "handled" so we don't retry inside the window.
    await tryInsertLog(user.id, 'digest', dedupeKey);
    return;
  }

  // Insert the log row first — on unique-violation, bail out (already sent).
  const inserted = await tryInsertLog(user.id, 'digest', dedupeKey);
  if (!inserted) {
    logger.debug({ userId: user.id, dedupeKey }, 'digest already sent today');
    return;
  }

  // Find all of the user's pending occurrences for today (across all families).
  const todayStart = new Date(`${today}T00:00:00.000Z`);
  const todayEnd = new Date(`${today}T23:59:59.999Z`);
  const rows = await db
    .select({
      taskTitle: tasks.title,
      familyId: tasks.familyId,
      time: taskOccurrences.scheduledTime,
      points: tasks.points,
    })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .innerJoin(familyMembers, eq(familyMembers.familyId, tasks.familyId))
    .where(
      and(
        eq(familyMembers.userId, user.id),
        isNull(tasks.archivedAt),
        eq(taskOccurrences.status, 'pending'),
        or(
          eq(taskOccurrences.assigneeId, user.id),
          isNull(taskOccurrences.assigneeId),
          // Shared task I participate in (assignee is the responsible).
          sql`${tasks.participantIds} @> ARRAY[${user.id}]::uuid[]`,
        ),
        or(
          and(
            gte(taskOccurrences.scheduledDate, today),
            lte(taskOccurrences.scheduledDate, today),
          ),
          // Date-less pending rows (floating tasks) are also "for today" in
          // the sense that they're outstanding work.
          and(
            isNull(taskOccurrences.scheduledDate),
            // available_at must be in the past (or absent) — i.e. not on cooldown.
            or(
              isNull(taskOccurrences.availableAt),
              lte(taskOccurrences.availableAt, todayEnd),
            ),
          ),
        ),
      ),
    );

  const isEn = user.locale === 'en';
  const lines: string[] = [];
  lines.push(isEn ? '☀️ Morning! Today on your list:' : '☀️ Доброе утро! На сегодня:');

  // ── Today ──────────────────────────────────────────────────────
  if (rows.length === 0) {
    lines.push('');
    lines.push(isEn ? '🎉 Nothing scheduled — enjoy.' : '🎉 На сегодня пусто — отдыхай.');
  } else {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const time = r.time ? ` · ${r.time.slice(0, 5)}` : '';
      const pts = r.points > 0 ? ` · +${r.points}` : '';
      lines.push(`${i + 1}. ${r.taskTitle}${time}${pts}`);
    }
  }
  void todayStart;

  // Collect family-scoped extras across every family the user belongs to.
  const memberships = await db
    .select({
      familyId: familyMembers.familyId,
      permissions: roles.permissions,
    })
    .from(familyMembers)
    .innerJoin(roles, eq(familyMembers.roleId, roles.id))
    .where(eq(familyMembers.userId, user.id));

  // ── Overdue ────────────────────────────────────────────────────
  // Pending occurrences with scheduled_date < today that are still
  // assigned to the user (or unassigned). Cap at 5 entries so the
  // digest stays readable; collapse the rest behind a "+N more" line.
  const overdue = await db
    .select({
      title: tasks.title,
      date: taskOccurrences.scheduledDate,
    })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .innerJoin(familyMembers, eq(familyMembers.familyId, tasks.familyId))
    .where(
      and(
        eq(familyMembers.userId, user.id),
        isNull(tasks.archivedAt),
        eq(taskOccurrences.status, 'pending'),
        lt(taskOccurrences.scheduledDate, today),
        or(
          eq(taskOccurrences.assigneeId, user.id),
          isNull(taskOccurrences.assigneeId),
          sql`${tasks.participantIds} @> ARRAY[${user.id}]::uuid[]`,
        ),
      ),
    )
    .orderBy(desc(taskOccurrences.scheduledDate))
    .limit(6);
  if (overdue.length > 0) {
    lines.push('');
    lines.push(isEn ? '⏰ Overdue:' : '⏰ Просрочено:');
    const shown = overdue.slice(0, 5);
    for (const r of shown) {
      lines.push(`• ${r.title} — ${r.date}`);
    }
    if (overdue.length > 5) {
      lines.push(isEn ? `  +${overdue.length - 5} more` : `  +${overdue.length - 5} ещё`);
    }
  }

  // ── Birthdays / events in the next 7 days ──────────────────────
  if (memberships.length > 0) {
    const familyIds = memberships.map((m) => m.familyId);
    const allEvents = await db
      .select()
      .from(familyEvents)
      .where(
        and(
          // drizzle-orm `inArray` would be cleaner, but we already pull
          // memberships; an OR-chain with .where is equally cheap on
          // a small N (most users belong to 1–2 families).
          familyIds.length === 1
            ? eq(familyEvents.familyId, familyIds[0]!)
            : or(...familyIds.map((id) => eq(familyEvents.familyId, id))),
          isNull(familyEvents.deletedAt),
        ),
      );
    const todayDate = new Date();
    const upcoming = allEvents
      .map((e) => ({ ev: e, days: daysUntil(e.month, e.day, todayDate) }))
      .filter((x) => x.days >= 0 && x.days <= 7)
      .sort((a, b) => a.days - b.days);
    if (upcoming.length > 0) {
      lines.push('');
      lines.push(isEn ? '🎂 Soon:' : '🎂 Скоро:');
      for (const { ev, days } of upcoming) {
        const emoji = ev.emoji ?? eventEmojiFor(ev.type);
        const when =
          days === 0
            ? isEn
              ? 'today'
              : 'сегодня'
            : days === 1
              ? isEn
                ? 'tomorrow'
                : 'завтра'
              : isEn
                ? `in ${days}d`
                : `через ${days} дн.`;
        lines.push(`${emoji} ${ev.title} — ${when}`);
      }
    }
  }

  // ── Pending approvals (only if user has task.approve somewhere) ─
  const approverFamilyIds = memberships
    .filter((m) => (m.permissions as string[]).includes('task.approve'))
    .map((m) => m.familyId);
  if (approverFamilyIds.length > 0) {
    const pendingApprovals = await db
      .select({
        title: tasks.title,
      })
      .from(taskOccurrences)
      .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
      .where(
        and(
          approverFamilyIds.length === 1
            ? eq(tasks.familyId, approverFamilyIds[0]!)
            : or(...approverFamilyIds.map((id) => eq(tasks.familyId, id))),
          isNull(tasks.archivedAt),
          eq(taskOccurrences.status, 'pending_approval'),
        ),
      )
      .limit(5);
    if (pendingApprovals.length > 0) {
      lines.push('');
      lines.push(
        isEn
          ? `🔔 ${pendingApprovals.length} awaiting your approval`
          : `🔔 ${pendingApprovals.length} ждёт одобрения`,
      );
      for (const r of pendingApprovals) {
        lines.push(`• ${r.title}`);
      }
    }
  }

  // ── Pinned notes from any family the user is in ────────────────
  if (memberships.length > 0) {
    const familyIds = memberships.map((m) => m.familyId);
    const pinnedRows = await db
      .select()
      .from(families)
      .where(
        familyIds.length === 1
          ? eq(families.id, familyIds[0]!)
          : or(...familyIds.map((id) => eq(families.id, id))),
      );
    const notes = pinnedRows.filter((f) => f.pinnedNote);
    if (notes.length > 0) {
      lines.push('');
      lines.push(isEn ? '📌 Family note:' : '📌 Семейная заметка:');
      for (const f of notes) {
        // Truncate hard at 200 chars so a long note doesn't dominate the digest.
        const note = f.pinnedNote!.length > 200 ? f.pinnedNote!.slice(0, 197) + '…' : f.pinnedNote;
        lines.push(`  ${note}`);
      }
    }
  }

  await sendBotMessage({
    chatId: Number(user.telegramId),
    text: lines.join('\n'),
  });
}

function eventEmojiFor(type: string): string {
  switch (type) {
    case 'birthday':
      return '🎂';
    case 'anniversary':
      return '💍';
    case 'nameday':
      return '✨';
    case 'memorial':
      return '🕯️';
    default:
      return '📅';
  }
}

async function tryInsertLog(userId: string, kind: string, dedupeKey: string): Promise<boolean> {
  try {
    await db.insert(notificationsLog).values({ userId, kind, dedupeKey });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return false;
    throw err;
  }
}
