import { customAlphabet } from 'nanoid';
import { and, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  families,
  familyEvents,
  familyMembers,
  icsTokens,
  taskOccurrences,
  tasks,
  type IcsTokenRow,
} from '../db/schema';
import { forecastQueueOccurrences } from './queue-forecast';

const tokenAlphabet = customAlphabet(
  'abcdefghijklmnopqrstuvwxyz0123456789',
  32,
);

/**
 * ICS token issue / revoke / list. We keep one active token per
 * (user, family) — re-issuing rotates: the old row is marked revoked,
 * a new one is inserted. Token strings are 32 chars from a 36-char
 * alphabet (~165 bits of entropy) — safe to put in a URL.
 */

export async function issueToken(input: {
  userId: string;
  familyId: string;
}): Promise<IcsTokenRow> {
  // Revoke any existing live token for this (user, family).
  await db
    .update(icsTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(icsTokens.userId, input.userId),
        eq(icsTokens.familyId, input.familyId),
        isNull(icsTokens.revokedAt),
      ),
    );
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = tokenAlphabet();
    try {
      const [row] = await db
        .insert(icsTokens)
        .values({
          userId: input.userId,
          familyId: input.familyId,
          token,
        })
        .returning();
      return row!;
    } catch (err) {
      // 23505 = unique_violation on the token column; retry with new.
      if ((err as { code?: string }).code !== '23505') throw err;
    }
  }
  throw new Error('ICS token generation collided 5 times — giving up');
}

export async function findActiveToken(input: {
  userId: string;
  familyId: string;
}): Promise<IcsTokenRow | null> {
  const row = await db.query.icsTokens.findFirst({
    where: and(
      eq(icsTokens.userId, input.userId),
      eq(icsTokens.familyId, input.familyId),
      isNull(icsTokens.revokedAt),
    ),
  });
  return row ?? null;
}

export async function revokeActiveToken(input: {
  userId: string;
  familyId: string;
}): Promise<boolean> {
  const res = await db
    .update(icsTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(icsTokens.userId, input.userId),
        eq(icsTokens.familyId, input.familyId),
        isNull(icsTokens.revokedAt),
      ),
    )
    .returning({ id: icsTokens.id });
  return res.length > 0;
}

/** Look up the family-id this token authorises. Marks lastUsedAt for
 *  observability. Returns null when the token is unknown / revoked. */
export async function resolveToken(token: string): Promise<{
  userId: string;
  familyId: string;
} | null> {
  const row = await db.query.icsTokens.findFirst({
    where: and(eq(icsTokens.token, token), isNull(icsTokens.revokedAt)),
  });
  if (!row) return null;
  // Fire-and-forget last-used update — the calendar app might poll
  // every 30 min, no point waiting on the write.
  void db
    .update(icsTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(icsTokens.id, row.id))
    .catch(() => undefined);
  return { userId: row.userId, familyId: row.familyId };
}

/**
 * Generate a personal ICS document. Mirrors the in-app calendar query
 * (see `listFamilyOccurrences`) so every occurrence the user sees in
 * the app shows up in their subscribed calendar.
 *
 * Per-user scope:
 *   - `userId` comes from the token. We include occurrences assigned to
 *     this user PLUS unassigned occurrences (shared/anyone tasks the
 *     in-app calendar shows to everyone). Other people's personal
 *     assignments are hidden — this is a personal feed.
 *
 * Status handling — DONE rows are excluded entirely per user request
 * ("во внешний календарь не передавать выполненные задачи"). External
 * calendars are a forward-looking view of what needs doing; completion
 * history lives in-app. Remaining statuses:
 *   - pending           → plain title
 *   - pending_approval  → "⏳ Title" + STATUS:TENTATIVE (greyed out)
 *   - skipped / expired → "⊘ Title" + STATUS:CANCELLED (struck-through)
 *
 * Date handling:
 *   - Dated rows inside ±window appear on their scheduled date.
 *   - Pending dateless rows (the "Когда-нибудь" / queued backlog the
 *     in-app calendar pins to today) are anchored on the current day
 *     as all-day events. Same anchor the miniapp uses.
 *
 * Window: 90 days back, 365 forward. Calendar apps cache aggressively;
 * we err wide so a once-a-day fetch covers the next year.
 *
 * Output uses CRLF per RFC 5545. We don't fold lines (the RFC asks for
 * ≤75 octets per line) — modern parsers accept unfolded lines and our
 * titles are usually short.
 */
export async function generateFamilyIcs(input: {
  familyId: string;
  /** Token-owning user. Filters occurrences to "mine + unassigned". */
  userId: string;
}): Promise<string> {
  const family = await db.query.families.findFirst({
    where: eq(families.id, input.familyId),
  });
  if (!family) return emptyIcs('Family');

  const today = new Date();
  const from = new Date(today.getTime() - 90 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const to = new Date(today.getTime() + 365 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const todayIso = today.toISOString().slice(0, 10);

  const rows = await db
    .select({
      id: taskOccurrences.id,
      taskId: taskOccurrences.taskId,
      scheduledDate: taskOccurrences.scheduledDate,
      scheduledTime: taskOccurrences.scheduledTime,
      status: taskOccurrences.status,
      assigneeId: taskOccurrences.assigneeId,
      availableAt: taskOccurrences.availableAt,
      taskType: tasks.type,
      title: tasks.title,
      description: tasks.description,
    })
    .from(taskOccurrences)
    .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
    .where(
      and(
        eq(tasks.familyId, input.familyId),
        isNull(tasks.archivedAt),
        // Personal feed rules:
        //   1. Mine by occurrence assignment.
        //   2. Mine by completion (I closed it — even if assigned
        //      elsewhere, like a transferred task or a child's task
        //      a parent finished).
        //   3. Genuinely shared: occurrence assignee is null AND the
        //      underlying task's assignee is null too. (If the task
        //      is assigned to a specific user but the occurrence row
        //      is missing that, treat it as "theirs, not mine" — this
        //      is the floating-completion regression the user hit.)
        or(
          eq(taskOccurrences.assigneeId, input.userId),
          eq(taskOccurrences.completedBy, input.userId),
          and(
            isNull(taskOccurrences.assigneeId),
            or(
              eq(tasks.assigneeId, input.userId),
              isNull(tasks.assigneeId),
            ),
          ),
          // 4. Shared task: I'm a participant (the occurrence assignee is
          //    the responsible, not me, so the clauses above miss it).
          sql`${tasks.participantIds} @> ARRAY[${input.userId}]::uuid[]`,
        ),
        // Drop completed occurrences entirely — see file docstring.
        ne(taskOccurrences.status, 'done'),
        or(
          // Dated rows inside the visible window.
          and(
            gte(taskOccurrences.scheduledDate, from),
            lte(taskOccurrences.scheduledDate, to),
          ),
          // Dateless pending (queued / "Когда-нибудь"). We pull
          // these in regardless of availableAt — the anchor logic
          // below maps them to today (or to availableAt's day when
          // it's in the future, i.e. the cooldown row's actual
          // next-turn date). The earlier shape that hard-dropped
          // future-availableAt rows here pushed the cooldown's
          // forecast onto today + step, breaking "счёт с последнего
          // выполнения".
          and(
            isNull(taskOccurrences.scheduledDate),
            eq(taskOccurrences.status, 'pending'),
          ),
        ),
      ),
    );

  // Dedupe dateless pendings per task. The DB can hold more than one
  // such row for a single task (legacy state from the old
  // completeFloatingTask reopen bug, before its assignee-inherit fix).
  // Without this every row anchors to today and the feed shows the
  // same task title N times. Keep the first row per task; the next
  // ensureQueuedOccurrence / completion cycle will self-heal the
  // duplicates in the DB.
  const seenDatelessByTask = new Set<string>();
  // Track which task ids have ANY emitted row (dated or dateless) so
  // the floating-synthesis pass below knows whether it'd duplicate.
  const tasksWithEmittedRow = new Set<string>();
  const events = rows
    .map((r) => {
      const isDateless = !r.scheduledDate;
      if (isDateless) {
        if (seenDatelessByTask.has(r.taskId)) return null;
        seenDatelessByTask.add(r.taskId);
      }
      tasksWithEmittedRow.add(r.taskId);
      // Anchor:
      //   - scheduledDate when present;
      //   - else, if there's a future availableAt (cooldown row),
      //     anchor on that day — that's when the task is actually
      //     due (= completion + cooldownDays);
      //   - else today.
      let anchor = r.scheduledDate ?? todayIso;
      if (!r.scheduledDate && r.availableAt && r.availableAt.getTime() > today.getTime()) {
        anchor = r.availableAt.toISOString().slice(0, 10);
      }
      const presentation = presentStatus(r.status);
      return formatVEvent({
        uid: `occ:${r.id}@family-todo`,
        title: presentation.prefix
          ? `${presentation.prefix} ${r.title}`
          : r.title,
        description: r.description ?? '',
        date: anchor,
        time: r.scheduledTime ?? null,
        status: presentation.icsStatus,
      });
    })
    .filter((s): s is string => s !== null);

  // Floating-task synthesis. A fresh `floating` task (just created,
  // never completed) has NO row in `task_occurrences` — the planner
  // returns [] for floating + queued types. Without this pass the ICS
  // feed silently drops it, which is what the user just reported:
  // "Теперь во внешнем календаре нет задачи без даты. Надо чтобы
  // задачи без даты передавались на сегодня". The in-app calendar
  // synthesises the same "anchor on today" placeholder via the
  // `byDate` floating-injection — mirror that here.
  //
  // Cooldown gate: if the task has a `cooldownDays` and the latest
  // done completion falls inside that window, skip it. The user's
  // follow-up: "Но это если кд позволяет".
  //
  // Personal-feed gate: only emit when the task is mine
  // (`task.assigneeId === userId`) or unassigned. Mirrors the main
  // query's "mine + shared" rule.
  const floatingTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      cooldownDays: tasks.cooldownDays,
      singleShot: tasks.singleShot,
      assigneeId: tasks.assigneeId,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.familyId, input.familyId),
        isNull(tasks.archivedAt),
        eq(tasks.type, 'floating'),
        or(eq(tasks.assigneeId, input.userId), isNull(tasks.assigneeId)),
      ),
    );

  const floatingSyntheticEvents: string[] = [];
  if (floatingTasks.length > 0) {
    const floatingIds = floatingTasks.map((t) => t.id);
    // Two side-channels per task:
    //   - hasPendingRow: any pending occurrence at all (even one with
    //     future availableAt — that's the cooldown row that the SQL
    //     filter intentionally dropped from `events`). Either way the
    //     existing row owns the today anchor / cooldown state, so we
    //     shouldn't synthesise a duplicate today VEVENT.
    //   - lastDoneByTask: latest completedAt — feeds the cooldown
    //     gate for tasks that have NO pending row (the
    //     reopen_immediately path that didn't insert one, or a
    //     historical singleShot done where archive somehow didn't
    //     fire).
    const allRows = await db
      .select({
        taskId: taskOccurrences.taskId,
        status: taskOccurrences.status,
        completedAt: taskOccurrences.completedAt,
      })
      .from(taskOccurrences)
      .where(inArray(taskOccurrences.taskId, floatingIds));
    const hasPendingRow = new Set<string>();
    const lastDoneByTask = new Map<string, Date>();
    for (const r of allRows) {
      if (r.status === 'pending') {
        hasPendingRow.add(r.taskId);
      } else if (r.status === 'done' && r.completedAt) {
        const prev = lastDoneByTask.get(r.taskId);
        if (!prev || r.completedAt.getTime() > prev.getTime()) {
          lastDoneByTask.set(r.taskId, r.completedAt);
        }
      }
    }

    const nowMs = today.getTime();
    for (const ft of floatingTasks) {
      // Already emitted from a real row in the main query — leave it
      // alone, the dedup pass took care of it.
      if (tasksWithEmittedRow.has(ft.id)) continue;
      // Existing pending row in the DB (even one that the SQL filter
      // dropped because availableAt is still in the future). The
      // existing row is the source of truth for whether the task
      // shows up — don't second-guess it with synthesis.
      if (hasPendingRow.has(ft.id)) continue;
      const last = lastDoneByTask.get(ft.id);
      // singleShot tasks that have been done are spent — even if the
      // archive flag somehow didn't get set, we should not resurrect
      // them in the calendar.
      if (ft.singleShot && last) continue;
      // Cooldown gate.
      if (ft.cooldownDays && ft.cooldownDays > 0 && last) {
        if (last.getTime() + ft.cooldownDays * 86_400_000 > nowMs) {
          continue;
        }
      }
      floatingSyntheticEvents.push(
        formatVEvent({
          uid: `floating:${ft.id}@family-todo`,
          title: ft.title,
          description: ft.description ?? '',
          date: todayIso,
          time: null,
          status: null,
        }),
      );
    }
  }

  // Queue forecast — the miniapp's Calendar projects future rotations of
  // queued tasks client-side because only one real pending occurrence
  // exists at a time. Mirror that here so the ICS feed shows the same
  // "my turn" days. We need (a) every queued task in the family and
  // (b) the current pending occurrence of each (regardless of who it's
  // assigned to — we need it as the rotation pivot) and (c) the member
  // roster as a fallback when `queueUserIds` is null.
  const queueTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.familyId, input.familyId),
        isNull(tasks.archivedAt),
        eq(tasks.type, 'queued'),
      ),
    );

  const forecastEvents: string[] = [];
  if (queueTasks.length > 0) {
    const queueTaskIds = queueTasks.map((t) => t.id);
    const [queueCurrent, memberRows, completionRows, lastDoneRows] = await Promise.all([
      db
        .select({
          taskId: taskOccurrences.taskId,
          status: taskOccurrences.status,
          assigneeId: taskOccurrences.assigneeId,
          scheduledTime: taskOccurrences.scheduledTime,
          availableAt: taskOccurrences.availableAt,
          title: tasks.title,
          description: tasks.description,
        })
        .from(taskOccurrences)
        .innerJoin(tasks, eq(taskOccurrences.taskId, tasks.id))
        .where(
          and(
            eq(tasks.familyId, input.familyId),
            eq(tasks.type, 'queued'),
            eq(taskOccurrences.status, 'pending'),
          ),
        ),
      db
        .select({ userId: familyMembers.userId, joinedAt: familyMembers.joinedAt })
        .from(familyMembers)
        .where(eq(familyMembers.familyId, input.familyId)),
      // Completion counts per (task, user) — feeds the balance-aware
      // forecast simulator below so the predicted assignees match what
      // pickNextAssignee will actually do.
      queueTaskIds.length > 0
        ? db
            .select({
              taskId: taskOccurrences.taskId,
              userId: taskOccurrences.completedBy,
              count: sql<number>`count(*)::int`,
            })
            .from(taskOccurrences)
            .where(
              and(
                inArray(taskOccurrences.taskId, queueTaskIds),
                eq(taskOccurrences.status, 'done'),
              ),
            )
            .groupBy(taskOccurrences.taskId, taskOccurrences.completedBy)
        : Promise.resolve(
            [] as { taskId: string; userId: string | null; count: number }[],
          ),
      // All done rows for the queue tasks; we'll fold them in JS to
      // get the latest completedBy per task. Avoids raw-SQL array
      // binding quirks while keeping the result O(n) in completions.
      queueTaskIds.length > 0
        ? db
            .select({
              taskId: taskOccurrences.taskId,
              completedBy: taskOccurrences.completedBy,
              completedAt: taskOccurrences.completedAt,
            })
            .from(taskOccurrences)
            .where(
              and(
                inArray(taskOccurrences.taskId, queueTaskIds),
                eq(taskOccurrences.status, 'done'),
              ),
            )
        : Promise.resolve([] as {
            taskId: string;
            completedBy: string | null;
            completedAt: Date | null;
          }[]),
    ]);

    const titleByTask = new Map(queueCurrent.map((q) => [q.taskId, q.title]));
    const descByTask = new Map(
      queueCurrent.map((q) => [q.taskId, q.description ?? '']),
    );

    const completionsByTaskUser = new Map<string, number>();
    for (const r of completionRows) {
      if (!r.userId) continue;
      completionsByTaskUser.set(`${r.taskId}:${r.userId}`, Number(r.count));
    }
    // Fold all-done-rows into per-task latest completedBy. O(n) pass.
    const lastCompleterByTask = new Map<string, string | null>();
    const latestAt = new Map<string, number>();
    for (const r of lastDoneRows as {
      taskId: string;
      completedBy: string | null;
      completedAt: Date | null;
    }[]) {
      if (!r.completedAt) continue;
      const ts = r.completedAt.getTime();
      const prev = latestAt.get(r.taskId) ?? -Infinity;
      if (ts > prev) {
        latestAt.set(r.taskId, ts);
        lastCompleterByTask.set(r.taskId, r.completedBy);
      }
    }
    const joinedAtByUser = new Map(memberRows.map((m) => [m.userId, m.joinedAt]));

    // Trim the forecast window so a daily-or-weekly queue task doesn't
    // emit 60+ events 365 days out. ~60 days forward is plenty for
    // "see when my next turns are" without overwhelming the calendar.
    // The 'to' limit on the rows query stays at +365 — that's only an
    // upper bound for stored occurrences, which are real.
    const forecastTo = new Date(today.getTime() + 60 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const forecast = forecastQueueOccurrences({
      tasks: queueTasks,
      occurrences: queueCurrent,
      memberIds: memberRows.map((m) => m.userId),
      completionsByTaskUser,
      lastCompleterByTask,
      joinedAtByUser,
      todayIso,
      toIso: forecastTo,
    });

    for (const f of forecast) {
      // Personal feed: only forecast days when it's THIS user's turn.
      if (f.assigneeId !== input.userId) continue;
      const title = titleByTask.get(f.taskId);
      if (!title) continue; // task has no current pending row — skip
      forecastEvents.push(
        formatVEvent({
          uid: `${f.id}@family-todo`,
          title,
          description: descByTask.get(f.taskId) ?? '',
          date: f.scheduledDate,
          time: f.scheduledTime,
          status: null,
        }),
      );
    }
  }

  // Family events (birthdays, anniversaries, etc.). Stored as month+day
  // (+ optional birth year) so they recur annually. We anchor on this
  // year's MM-DD and use RRULE:FREQ=YEARLY so Apple/Google/Outlook
  // expand them forward forever — no need to emit one VEVENT per year.
  // Soft-deleted rows are excluded. The personal scope rule applies in
  // a relaxed form: events for OTHER members still appear in this
  // user's feed because birthdays are shared family info, not personal
  // assignments. (If we hid Zakir's birthday from the spouse's feed
  // that would be more confusing than helpful.)
  const events2 = await db
    .select()
    .from(familyEvents)
    .where(
      and(eq(familyEvents.familyId, input.familyId), isNull(familyEvents.deletedAt)),
    );
  const eventVEvents = events2.map((e) => {
    // Anchor the recurring series on this year. iso "YYYY-MM-DD" → ICS
    // wants the bare-date form YYYYMMDD for an all-day event.
    const yy = today.getUTCFullYear();
    const mm = String(e.month).padStart(2, '0');
    const dd = String(e.day).padStart(2, '0');
    const dt = `${yy}${mm}${dd}`;
    // DTEND = next day per RFC 5545 (all-day events are exclusive at end).
    const endDate = new Date(Date.UTC(yy, e.month - 1, e.day + 1));
    const ey = endDate.getUTCFullYear();
    const em = String(endDate.getUTCMonth() + 1).padStart(2, '0');
    const ed = String(endDate.getUTCDate()).padStart(2, '0');
    const dtEnd = `${ey}${em}${ed}`;
    const ageNote =
      e.year && e.type === 'birthday'
        ? ` (${yy - e.year})`
        : '';
    const summary = `${e.emoji ?? '🎂'} ${e.title}${ageNote}`;
    return [
      'BEGIN:VEVENT',
      `UID:famevent:${e.id}@family-todo`,
      `DTSTAMP:${formatDateTimeUtc(new Date())}Z`,
      `DTSTART;VALUE=DATE:${dt}`,
      `DTEND;VALUE=DATE:${dtEnd}`,
      // Annual recurrence forever — calendar apps expand on demand.
      'RRULE:FREQ=YEARLY',
      `SUMMARY:${escapeIcs(summary)}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    ].join('\r\n');
  });

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Family Todo//RU',
    `X-WR-CALNAME:${escapeIcs(family.name)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...events,
    ...floatingSyntheticEvents,
    ...forecastEvents,
    ...eventVEvents,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function emptyIcs(name: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Family Todo//RU',
    `X-WR-CALNAME:${escapeIcs(name)}`,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function formatVEvent(input: {
  uid: string;
  title: string;
  description: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM or HH:MM:SS, optional */
  time: string | null;
  /** Optional RFC 5545 STATUS property value (CONFIRMED / TENTATIVE /
   *  CANCELLED / COMPLETED). When set, capable clients render the
   *  event differently (strikethrough for COMPLETED/CANCELLED, greyed
   *  out for TENTATIVE). The SUMMARY prefix is the universal fallback
   *  for clients that ignore STATUS. */
  status?: 'COMPLETED' | 'TENTATIVE' | 'CANCELLED' | null;
}): string {
  const dtStamp = formatDateTimeUtc(new Date());
  const [y, m, d] = input.date.split('-');
  let dtStart: string;
  let dtEnd: string;
  if (input.time) {
    const [hh, mm] = input.time.split(':');
    // Anchor in floating local time (no TZID) so the user's calendar
    // app shows it in their local clock — the family's tz on the
    // server is metadata only.
    dtStart = `${y}${m}${d}T${hh}${mm}00`;
    // 30-min default duration; aligns with typical chore window.
    const end = new Date(`${y}-${m}-${d}T${hh}:${mm}:00`);
    end.setMinutes(end.getMinutes() + 30);
    const ey = end.getFullYear();
    const em = String(end.getMonth() + 1).padStart(2, '0');
    const ed = String(end.getDate()).padStart(2, '0');
    const ehh = String(end.getHours()).padStart(2, '0');
    const emm = String(end.getMinutes()).padStart(2, '0');
    dtEnd = `${ey}${em}${ed}T${ehh}${emm}00`;
  } else {
    // All-day event: DTSTART;VALUE=DATE — DTEND is the day AFTER per RFC.
    dtStart = `${y}${m}${d}`;
    const next = new Date(`${y}-${m}-${d}T00:00:00`);
    next.setDate(next.getDate() + 1);
    dtEnd =
      `${next.getFullYear()}` +
      String(next.getMonth() + 1).padStart(2, '0') +
      String(next.getDate()).padStart(2, '0');
  }
  const dateParam = input.time ? '' : ';VALUE=DATE';
  return [
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${dtStamp}Z`,
    `DTSTART${dateParam}:${dtStart}`,
    `DTEND${dateParam}:${dtEnd}`,
    `SUMMARY:${escapeIcs(input.title)}`,
    ...(input.description
      ? [`DESCRIPTION:${escapeIcs(input.description)}`]
      : []),
    ...(input.status ? [`STATUS:${input.status}`] : []),
    'END:VEVENT',
  ].join('\r\n');
}

/** Map our internal occurrence status to (a) a SUMMARY prefix that
 *  works in every client, and (b) an RFC 5545 STATUS value (or null
 *  when the default CONFIRMED is fine). Keeping this in one function
 *  means a glance at the calendar tells you the task state without
 *  having to inspect each event. */
function presentStatus(status: string): {
  prefix: string | null;
  icsStatus: 'TENTATIVE' | 'CANCELLED' | null;
} {
  switch (status) {
    case 'pending_approval':
      // Hourglass = "waiting on approval". TENTATIVE makes most
      // clients render the event greyed out.
      return { prefix: '⏳', icsStatus: 'TENTATIVE' };
    case 'skipped':
    case 'expired':
      // Slashed-zero looks like a "no" badge; CANCELLED gives
      // strike-through. We still show these so the user can see
      // what got dropped.
      return { prefix: '⊘', icsStatus: 'CANCELLED' };
    // 'done' is filtered at the SQL layer — feed is forward-looking.
    case 'pending':
    default:
      return { prefix: null, icsStatus: null };
  }
}

/** Convert a Date (or null) to YYYY-MM-DD in UTC. Returns null when the
 *  input is null — callers use this to anchor floating completions on
 *  their completedAt timestamp. UTC keeps the anchor stable regardless
 *  of the server's local clock, mirroring how `scheduledDate` (stored
 *  as a bare `date`) is treated. */
function isoDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function formatDateTimeUtc(d: Date): string {
  return (
    d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') +
    'T' +
    String(d.getUTCHours()).padStart(2, '0') +
    String(d.getUTCMinutes()).padStart(2, '0') +
    String(d.getUTCSeconds()).padStart(2, '0')
  );
}

function escapeIcs(s: string): string {
  // RFC 5545 §3.3.11: backslash, semicolon, comma, newline need escaping.
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}
