import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
  type OccurrenceDto,
  type TaskDto,
} from '../api';
import { AvStack, Dot, Icon, Seg, Tag, WfBody, type Member } from '../design';
import { FloatingSection } from '../components/FloatingSection';
import { PinnedNote } from '../components/PinnedNote';
import { useToast } from '../components/Toast';
import { usePreferences } from '../hooks/usePreferences';
import { useDragReschedule } from '../hooks/useDragReschedule';
import { pluralize, useT } from '../i18n';
import { pickInkOrPaper } from '../utils/contrast';
import { forecastQueueOccurrences } from '../utils/queueForecast';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  families?: FamilySummary[];
  onSwitchFamily?: (id: string) => void;
  onOpenDay?: (iso: string) => void;
  onOpenTask?: (occurrence: OccurrenceDto) => void;
  onCreateTask?: (iso: string) => void;
  /** Banner "Invite your family" tap target — sends user to Profile where
   *  the actual InviteCard (copy/share buttons) lives. */
  onOpenInvite?: () => void;
  /** Burger button at the top-left opens this. Top-level pages get a burger
   *  in their header to access the navigation drawer; sub-pages don't. */
  onOpenDrawer?: () => void;
  /** Back button (shown instead of the burger when the user reached this
   *  page via in-app navigation rather than via the drawer). */
  onBack?: () => void;
};

// All localised date-label arrays are capitalised + length-matched to
// their EN counterparts so the layout doesn't wobble per language. User
// said: "почему на английском с большой буквы, а на русском с маленькой,
// нужно тоже с большой. и месяц нужно сократить до 3 букв, как и на
// английском" — RU short months drop the genitive case (no clean
// 3-letter genitive exists) and use nominative-stem abbreviations.
const WK_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WK_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES_RU = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];
const MONTH_NAMES_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
// 3-letter abbreviations. We used to ship the RU genitive (e.g. "5 мая")
// but that overflowed in narrow cells. Matching EN's "5 May" treatment.
const MONTH_GENITIVE_RU = [
  'Янв',
  'Фев',
  'Мар',
  'Апр',
  'Май',
  'Июн',
  'Июл',
  'Авг',
  'Сен',
  'Окт',
  'Ноя',
  'Дек',
];
const MONTH_GENITIVE_EN = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const DOW_SHORT_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const DOW_SHORT_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function memberFromDto(dto: FamilyMemberDto): Member {
  return {
    id: dto.id,
    name: dto.firstName,
    letter: dto.firstName.slice(0, 1).toUpperCase(),
    color: dto.color,
    role: dto.role.name,
    awayUntil: dto.awayUntil,
    awayReason: dto.awayReason,
  };
}

/**
 * Port of CalV1 (screens-calendar.jsx lines 46-141) — the selected wireframe
 * variant A. Layout, classes and inline styles preserved; data wired to API.
 */
export function Calendar({
  me,
  family,
  families = [],
  onSwitchFamily,
  onOpenDay,
  onOpenTask,
  onCreateTask,
  onOpenInvite,
  onOpenDrawer,
  onBack,
}: Props) {
  const queryClient = useQueryClient();
  const t = useT();
  const isEn = t.locale === 'en';
  const WK = isEn ? WK_EN : WK_RU;
  const MONTH_NAMES = isEn ? MONTH_NAMES_EN : MONTH_NAMES_RU;
  const MONTH_GENITIVE = isEn ? MONTH_GENITIVE_EN : MONTH_GENITIVE_RU;
  const DOW_SHORT = isEn ? DOW_SHORT_EN : DOW_SHORT_RU;
  const [view, setView] = useState(() => new Date());
  const [selectedIso, setSelectedIso] = useState<string>(() => toIso(new Date()));
  // Collapsed/expanded state of the "Выполнено · N" card under the day list,
  // mirroring the Day screen so the bottom of the Calendar doesn't get
  // dominated by old completed rows.
  const [showDone, setShowDone] = useState(false);

  // Manual double-tap detection. The native `onDoubleClick` event is
  // unreliable on iOS/Telegram WebView — the OS often eats the second tap
  // as a zoom gesture or returns it as a single click. Tracking
  // (iso + timestamp) of the previous tap gives consistent behaviour on
  // both touch and mouse: tap = select day, double-tap inside DOUBLE_TAP_MS
  // on the SAME cell = drill into the Day screen.
  const DOUBLE_TAP_MS = 350;
  const lastTapRef = useRef<{ iso: string; t: number } | null>(null);
  const handleCellTap = (iso: string) => {
    const now = Date.now();
    const prev = lastTapRef.current;
    if (prev && prev.iso === iso && now - prev.t < DOUBLE_TAP_MS) {
      lastTapRef.current = null;
      onOpenDay?.(iso);
      return;
    }
    lastTapRef.current = { iso, t: now };
    setSelectedIso(iso);
  };

  const monthStart = new Date(view.getFullYear(), view.getMonth(), 1);
  const monthEnd = new Date(view.getFullYear(), view.getMonth() + 1, 0);
  const fromIso = toIso(monthStart);
  const toIsoStr = toIso(monthEnd);

  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });
  const occurrencesQuery = useQuery({
    queryKey: ['occurrences', family.id, fromIso, toIsoStr],
    queryFn: () => api.listOccurrences(family.id, fromIso, toIsoStr),
  });
  const tasksQuery = useQuery({
    queryKey: ['tasks', family.id],
    queryFn: () => api.listTasks(family.id),
  });
  // Family events (birthdays, anniversaries, etc.) are stored as
  // month+day (+ optional year) so they recur annually. We surface
  // them in the calendar's selected-day list — user complained that
  // adding a birthday wasn't reflected anywhere on the calendar.
  const familyEventsQuery = useQuery({
    queryKey: ['family-events', family.id],
    queryFn: () => api.listFamilyEvents(family.id),
  });

  const completeMut = useMutation({
    // Synthesized `floating:<taskId>` ids come from the "Когда-нибудь" rollup
    // (no real occurrence row exists yet). Route those through the dedicated
    // /complete-floating endpoint instead of POSTing to a fake occurrence id.
    mutationFn: (occurrenceId: string) => {
      if (occurrenceId.startsWith('floating:')) {
        const taskId = occurrenceId.slice('floating:'.length);
        return api.completeFloatingTask(family.id, taskId);
      }
      return api.completeOccurrence(family.id, occurrenceId);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] }),
  });
  const uncompleteMut = useMutation({
    mutationFn: (occurrenceId: string) => api.uncompleteOccurrence(family.id, occurrenceId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] }),
  });
  // Drag-to-reschedule: dropping a card onto a different cell fires
  // a /reschedule call. Errors (e.g. date conflict — same task already
  // exists on that day) are swallowed quietly here; the cleanest place
  // to surface them is the TaskSheet which already handles the same
  // mutation with proper messaging.
  const dragRescheduleMut = useMutation({
    mutationFn: (input: { occurrenceId: string; scheduledDate: string }) =>
      api.rescheduleOccurrence(family.id, input.occurrenceId, input.scheduledDate),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] }),
  });
  const dragReschedule = useDragReschedule({
    onDrop: (occurrenceId, targetIso) => {
      // Floating completions use synth `floating:<taskId>` ids; they
      // have no real occurrence row to reschedule. Bail silently — the
      // hook treats this as a no-op drop.
      if (occurrenceId.startsWith('floating:')) return;
      dragRescheduleMut.mutate({ occurrenceId, scheduledDate: targetIso });
    },
  });

  // ── bulk select mode ──────────────────────────────────────────────
  // When on, DayTaskCard rows render a checkbox and tapping a row
  // toggles its membership in `selectedIds` instead of opening the
  // task. A bottom action bar shows "Complete N" + Cancel.
  const bulkToast = useToast();
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectMode(false);
  };
  const bulkCompleteMut = useMutation({
    mutationFn: (ids: string[]) => api.bulkCompleteOccurrences(family.id, ids),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] });
      // Best-effort toast summary; rely on the page list to refresh.
      const ok = data.results.filter((r) => r.status !== 'error').length;
      const fail = data.results.filter((r) => r.status === 'error').length;
      const msg =
        fail === 0
          ? `${ok} ${t('bulk.completed')}`
          : `${ok} ${t('bulk.completed')} · ${fail} ${t('bulk.failed')}`;
      bulkToast.show({ message: msg, variant: fail === 0 ? 'success' : 'error' });
      clearSelection();
    },
  });

  const rawOccurrences = occurrencesQuery.data?.occurrences ?? [];
  const tasks = tasksQuery.data?.tasks ?? [];
  const members = useMemo(
    () => (membersQuery.data?.members ?? []).map(memberFromDto),
    [membersQuery.data],
  );
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const todayIso = toIso(new Date());

  // Forecast future queue rotations — see utils/queueForecast.ts. Queue
  // tasks are date-less in the DB, but we paint their predicted next
  // turns on the calendar so the user can see who's up and when. The
  // forecast respects per-task cooldown (or daily if none) and rotates
  // through `queueUserIds` starting after the current real assignee.
  const memberIds = useMemo(() => members.map((m) => m.id), [members]);
  // Per (task, user) completion counts + per-task last-completer feed
  // the balance-aware forecast simulator. Derived from the same
  // rawOccurrences list — no extra fetch.
  const completionsByTaskUser = useMemo(() => {
    const map = new Map<string, number>();
    for (const o of rawOccurrences) {
      if (o.status !== 'done' || !o.completedBy) continue;
      const key = `${o.taskId}:${o.completedBy}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [rawOccurrences]);
  const lastCompleterByTask = useMemo(() => {
    const map = new Map<string, string | null>();
    // We need the latest completion per task → scan once tracking max
    // completedAt per taskId.
    const latest = new Map<string, string>();
    for (const o of rawOccurrences) {
      if (o.status !== 'done' || !o.completedAt) continue;
      const prev = latest.get(o.taskId);
      if (!prev || o.completedAt > prev) latest.set(o.taskId, o.completedAt);
    }
    for (const o of rawOccurrences) {
      if (o.status !== 'done') continue;
      if (latest.get(o.taskId) === o.completedAt) {
        map.set(o.taskId, o.completedBy ?? null);
      }
    }
    return map;
  }, [rawOccurrences]);
  const joinedAtByUser = useMemo(() => new Map<string, Date>(), []);
  const queueForecast = useMemo(
    () =>
      forecastQueueOccurrences({
        tasks,
        occurrences: rawOccurrences,
        memberIds,
        completionsByTaskUser,
        lastCompleterByTask,
        joinedAtByUser,
        todayIso,
        toIso: toIsoStr,
      }),
    [
      tasks,
      rawOccurrences,
      memberIds,
      completionsByTaskUser,
      lastCompleterByTask,
      joinedAtByUser,
      todayIso,
      toIsoStr,
    ],
  );
  const combinedOccurrences = useMemo(
    () => [...rawOccurrences, ...queueForecast],
    [rawOccurrences, queueForecast],
  );

  // Filter Seg — Все / Мои / <member name>. Same shape as the Day screen
  // so navigating between them feels consistent. Applied before bucketing
  // into byDate so the calendar dots reflect the active filter too.
  const otherMembers = members.filter((m) => m.id !== me.id);
  const ALL_LBL = t('common.everyone');
  const MINE_LBL = t('common.mine');
  const filterItems: string[] = [ALL_LBL, MINE_LBL, ...otherMembers.map((m) => m.name)];
  const [filter, setFilter] = useState<string>(ALL_LBL);
  // Persistent secondary filters (chip row): pending-only, with-photo.
  // Stored in the per-user `preferences.calendarFilters` so a refresh keeps
  // the active filter shape.
  const { prefs, set: setPrefs } = usePreferences(me);
  const calFilters = (prefs.calendarFilters ?? {}) as {
    onlyPending?: boolean;
    onlyWithPhoto?: boolean;
    tagIds?: string[];
  };
  const onlyPending = calFilters.onlyPending === true;
  const onlyWithPhoto = calFilters.onlyWithPhoto === true;
  const filterTagIds = Array.isArray(calFilters.tagIds) ? calFilters.tagIds : [];
  const toggleFilter = (key: 'onlyPending' | 'onlyWithPhoto') => {
    setPrefs({
      calendarFilters: {
        ...calFilters,
        [key]: !calFilters[key],
      },
    });
  };
  const toggleTagFilter = (tagId: string) => {
    const next = filterTagIds.includes(tagId)
      ? filterTagIds.filter((x) => x !== tagId)
      : [...filterTagIds, tagId];
    setPrefs({ calendarFilters: { ...calFilters, tagIds: next } });
  };
  // Family's tag dictionary — used by the filter chip row + lookup for
  // task → tag membership during filtering.
  const tagsQuery = useQuery({
    queryKey: ['tags', family.id],
    queryFn: () => api.listTags(family.id),
  });
  const allTags = tagsQuery.data?.tags ?? [];
  const taskById = useMemo(() => new Map(tasks.map((tk) => [tk.id, tk])), [tasks]);

  // View mode: month grid (default), week expanded list, or 30-day agenda.
  // Persisted in preferences so refresh keeps the user's pick. Agenda is
  // a forward-looking flat list so it ignores the prev/next month chevrons.
  type ViewMode = 'month' | 'week' | 'agenda';
  const viewMode: ViewMode =
    prefs.calendarViewMode === 'week' || prefs.calendarViewMode === 'agenda'
      ? prefs.calendarViewMode
      : 'month';
  const setViewMode = (m: ViewMode) => setPrefs({ calendarViewMode: m });

  const occurrences = useMemo(() => {
    let list = combinedOccurrences;
    // "Мои" / "<member name>" filters match on assignee OR completer.
    // Filtering by assignee alone hid done rows where the user finished
    // someone else's task (or where the task was transferred), which
    // read as a bug: "I completed it, but it's not in my list?" Matching
    // either side keeps the user's own work visible across the lifecycle.
    if (filter === MINE_LBL) {
      list = list.filter((o) => o.assigneeId === me.id || o.completedBy === me.id);
    } else if (filter !== ALL_LBL) {
      const named = members.find((m) => m.name === filter);
      if (named) {
        list = list.filter(
          (o) => o.assigneeId === named.id || o.completedBy === named.id,
        );
      }
    }
    if (onlyPending) {
      list = list.filter((o) => o.status === 'pending');
    }
    if (onlyWithPhoto) {
      list = list.filter((o) => o.photoIds != null && o.photoIds.length > 0);
    }
    if (filterTagIds.length > 0) {
      // Occurrences carry the task by id only — look up the task's tagIds
      // through the map and check overlap. Forecast rows synthesise the
      // task client-side so they may not be in `taskById`; treat missing
      // as "no tags" which excludes them under any tag filter.
      const wanted = new Set(filterTagIds);
      list = list.filter((o) => {
        const tk = taskById.get(o.taskId);
        const ids = tk?.tagIds ?? [];
        return ids.some((id) => wanted.has(id));
      });
    }
    return list;
  }, [
    combinedOccurrences,
    filter,
    me.id,
    members,
    ALL_LBL,
    MINE_LBL,
    onlyPending,
    onlyWithPhoto,
    filterTagIds,
    taskById,
  ]);

  const byDate = useMemo(() => {
    const map = new Map<string, OccurrenceDto[]>();
    const nowMs = Date.now();
    for (const o of occurrences) {
      // Anchor logic for null-date rows:
      //   - done                                  → completedAt day
      //   - pending on cooldown (availableAt > now) → availableAt day.
      //     This is the next moment the task is actually due: it
      //     equals completedAt + cooldownDays for queue/floating rows
      //     seeded by completeOccurrence. Earlier we skipped these
      //     rows outright, but that meant the forecast cursor (which
      //     starts at today + step) effectively re-anchored the
      //     cooldown on today, breaking "счёт от последнего
      //     выполнения, не от сегодня".
      //   - pending otherwise                     → today
      let key: string;
      if (o.scheduledDate) {
        key = o.scheduledDate;
      } else if (o.status === 'done' && o.completedAt) {
        key = o.completedAt.slice(0, 10);
      } else if (o.status === 'pending') {
        if (o.availableAt && new Date(o.availableAt).getTime() > nowMs) {
          key = o.availableAt.slice(0, 10);
        } else {
          key = todayIso;
        }
      } else {
        key = '__floating__';
      }
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(o);
    }
    // Floating tasks that exist as a TASK row but have no occurrence
    // yet (newly created, never picked from "Когда-нибудь") still need
    // a today-dot — user just created "Hh" with no date and saw no
    // dot. Synthesise a placeholder per such task and inject under
    // today. UID `floating:<taskId>` matches the same shape the
    // FloatingPicker uses, so downstream code already understands it.
    //
    // Apply the same assignee / tag / photo filters we applied to
    // `occurrences` above — otherwise a floating task assigned to me
    // leaks through as a calendar dot when the filter is set to
    // another member (the day list reads from the filtered
    // occurrences and correctly hides the task, but the dot count
    // pulls from this synthesised set and shows it anyway).
    const occByTask = new Set(occurrences.map((o) => o.taskId));
    const namedFilterMember =
      filter !== ALL_LBL && filter !== MINE_LBL
        ? members.find((m) => m.name === filter)
        : null;
    const wantedTagIds = filterTagIds.length > 0 ? new Set(filterTagIds) : null;
    for (const tk of tasks) {
      if (tk.type !== 'floating' || tk.archivedAt) continue;
      if (occByTask.has(tk.id)) continue;
      // Assignee filter mirror.
      if (filter === MINE_LBL) {
        if (tk.assigneeId !== me.id) continue;
      } else if (namedFilterMember) {
        if (tk.assigneeId !== namedFilterMember.id) continue;
      }
      // Photo filter excludes synthesised rows entirely — they have
      // no completion and therefore no photoIds.
      if (onlyWithPhoto) continue;
      // Tag filter: drop tasks that don't carry any of the wanted
      // tag ids. Same rule the occurrences filter uses.
      if (wantedTagIds) {
        const ids = tk.tagIds ?? [];
        if (!ids.some((id) => wantedTagIds.has(id))) continue;
      }
      const synthOcc: OccurrenceDto = {
        id: `floating:${tk.id}`,
        taskId: tk.id,
        scheduledDate: null,
        scheduledTime: null,
        assigneeId: tk.assigneeId,
        status: 'pending',
        subtasks: null,
        completedAt: null,
        completedBy: null,
        photoIds: null,
        pointsAwarded: 0,
        availableAt: null,
        approvedAt: null,
        approvedBy: null,
        rejectedAt: null,
        rejectedBy: null,
        rejectionReason: null,
        task: {
          id: tk.id,
          title: tk.title,
          type: tk.type,
          points: tk.points,
          photoRequired: tk.photoRequired,
          requiresApproval: tk.requiresApproval,
          isQuest: tk.isQuest,
          deadlineAt: tk.deadlineAt,
        },
      };
      if (!map.has(todayIso)) map.set(todayIso, []);
      map.get(todayIso)!.push(synthOcc);
    }
    return map;
  }, [
    occurrences,
    tasks,
    todayIso,
    filter,
    members,
    me.id,
    ALL_LBL,
    MINE_LBL,
    onlyWithPhoto,
    filterTagIds,
  ]);

  const cells = useMemo(() => makeMonthCells(view), [view]);
  const todayDay = new Date().getDate();
  const sameMonthAsView =
    new Date().getMonth() === view.getMonth() &&
    new Date().getFullYear() === view.getFullYear();
  const selectedDay = Number(selectedIso.slice(8, 10));

  // Current user's actual balance — sourced from the server's points
  // ledger via `myBalance`. Originally this was computed locally by
  // summing `pointsAwarded` across the currently-visible (filtered)
  // occurrences, which produced two bugs at once: (1) the number changed
  // when filtering by another member (occurrences list no longer
  // included the user's own dones), and (2) even with the right
  // filter, it only summed the visible month and ignored
  // redemption spends, so it never matched the Shop's balance.
  const balanceQuery = useQuery({
    queryKey: ['balance', family.id, me.id],
    queryFn: () => api.myBalance(family.id),
  });
  const myPoints = balanceQuery.data?.points ?? 0;

  const selectedDate = new Date(`${selectedIso}T00:00:00`);
  const todayCount = byDate.get(todayIso)?.length ?? 0;
  const selectedOccurrences = byDate.get(selectedIso) ?? [];
  // Family events: a {month,day} pair matches any year, so we group by
  // "MM-DD" and look up the selected day. Also produce a per-iso set for
  // the month grid so we can put an indicator on cells that have events.
  const allFamilyEvents = familyEventsQuery.data?.events ?? [];
  const eventsByMonthDay = useMemo(() => {
    const map = new Map<string, typeof allFamilyEvents>();
    for (const e of allFamilyEvents) {
      const key = `${String(e.month).padStart(2, '0')}-${String(e.day).padStart(2, '0')}`;
      const cur = map.get(key);
      if (cur) cur.push(e);
      else map.set(key, [e]);
    }
    return map;
  }, [allFamilyEvents]);
  const monthDayOf = (iso: string) => iso.slice(5); // "YYYY-MM-DD" → "MM-DD"
  const selectedDayEvents = eventsByMonthDay.get(monthDayOf(selectedIso)) ?? [];
  // Pending tasks sort by scheduledTime (timed first, ascending; time-less
  // after). Same rule as Day.tsx — keeps the two surfaces consistent so a
  // user planning their morning sees the same order in both lists.
  const selectedPending = [
    ...selectedOccurrences.filter(
      (o) =>
        o.status !== 'done' &&
        // Synthetic placeholders we inject into byDate so floating
        // tasks (no occurrence yet) get a today-dot on the grid.
        // They already render in the "Когда-нибудь" rollup below;
        // showing them in the day list too would double them up.
        !o.id.startsWith('floating:'),
    ),
  ].sort(
    (a, b) => {
      const ta = a.scheduledTime ?? null;
      const tb = b.scheduledTime ?? null;
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1;
      if (tb == null) return -1;
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    },
  );
  const selectedDone = selectedOccurrences.filter((o) => o.status === 'done');
  const dayHeading = isEn
    ? `${DOW_SHORT[selectedDate.getDay()]}, ${MONTH_GENITIVE[selectedDate.getMonth()]} ${selectedDate.getDate()}`
    : `${DOW_SHORT[selectedDate.getDay()]}, ${selectedDate.getDate()} ${MONTH_GENITIVE[selectedDate.getMonth()]}`;
  const daySub =
    selectedIso === todayIso
      ? `${t('calendar.today')} · ${todayCount} ${pluralTaskI18n(todayCount, isEn)}`
      : `${selectedOccurrences.length} ${pluralTaskI18n(selectedOccurrences.length, isEn)}`;

  return (
    <WfBody>
      {/* Header — port of lines 52-64.
          Leading slot is a single black-pill button — either Back (in-app
          nav source) or burger (drawer source); never both. Matches
          PageHeader's style so all pages read consistently. */}
      <div className="wf-spread">
        <div className="wf-row wf-gap-6">
          {(onBack || onOpenDrawer) && (
            <button
              onClick={onBack ?? onOpenDrawer}
              aria-label={onBack ? t('common.back') : t('nav.menu')}
              style={{
                width: 36,
                height: 36,
                borderRadius: 999,
                background: 'var(--ink)',
                color: 'var(--paper)',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: 'none',
              }}
            >
              <Icon name={onBack ? 'chevL' : 'menu'} />
            </button>
          )}
          <button
            onClick={() => setView((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--ink)' }}
            aria-label={isEn ? 'Previous' : 'Предыдущий'}
          >
            <Icon name="chevL" />
          </button>
          {/* Header used to swap to a family <select> when the user
              belonged to multiple families. Per user request: "переклю-
              чатель семьи нужен только в настройках, и нигде в других
              местах" — so we always render the plain month-year here.
              The switcher lives on the Settings page (Profile.tsx). */}
          <span className="wf-h1">
            {capitalize(MONTH_NAMES[view.getMonth()] ?? '')} {view.getFullYear()}
          </span>
          <button
            onClick={() => setView((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--ink)' }}
            aria-label={isEn ? 'Next' : 'Следующий'}
          >
            <Icon name="chevR" />
          </button>
        </div>
        <div className="wf-row wf-gap-6">
          <AvStack members={members} size="sm" />
          {/* Balance pill — same size + padding as on the Shop page so
              switching tabs doesn't read as visual jitter. */}
          <span
            className="wf-tag solid"
            style={{ marginLeft: 4, fontSize: 14, padding: '4px 10px' }}
          >
            <Icon name="star" /> {myPoints}
          </span>
        </div>
      </div>

      {/* Family pinned note — short shared scratchpad ("В четверг гости",
          etc). Any member can edit. Hidden entirely if there's no note
          and we're at the empty-state CTA — the small "+ Pinned note"
          chip renders inside the component itself. */}
      <PinnedNote family={family} members={membersQuery.data?.members ?? []} />

      {/* View-mode toggle — Месяц / Неделя / Лента. Persisted in
          preferences.calendarViewMode. */}
      <Seg
        items={[t('calendar.view.month'), t('calendar.view.week'), t('calendar.view.agenda')]}
        active={
          viewMode === 'week'
            ? t('calendar.view.week')
            : viewMode === 'agenda'
              ? t('calendar.view.agenda')
              : t('calendar.view.month')
        }
        onChange={(v) => {
          if (v === t('calendar.view.week')) setViewMode('week');
          else if (v === t('calendar.view.agenda')) setViewMode('agenda');
          else setViewMode('month');
        }}
        full
      />

      {viewMode === 'month' && (
        // Month grid — port of lines 66-91. Tap a cell to select it (and
        // re-render the day list below); double-tap drills into Day.
        <div className="wf-cal">
          {WK.map((w) => (
            <div key={w} className="wkd">
              {w}
            </div>
          ))}
          {cells.map((c, i) => {
            const occ = byDate.get(c.iso) ?? [];
            const overdue =
              !c.dim && c.iso < todayIso && occ.some((o) => o.status === 'pending');
            const isToday = sameMonthAsView && !c.dim && c.n === todayDay;
            const isSel = !c.dim && c.iso === selectedIso && c.n === selectedDay;
            const cls = ['cell'];
            if (c.dim) cls.push('dim');
            if (isToday) cls.push('today');
            if (isSel) cls.push('selected');
            if (overdue) cls.push('has-overdue');
            // Show as many dots as fit (flex-wrap handles the line
            // breaks in .wf-cal .dots). User asked: "Надо чтобы на дне
            // отображало максимум точек, сколько влезает, а не в одну
            // строку". Cap at a safe maximum to avoid huge cells with
            // a hundred dots on data-rich families; the cell's CSS
            // overflow clips anything beyond.
            const shown = occ.slice(0, 12);
            const more = occ.length - shown.length;
            const cellBind = !c.dim ? dragReschedule.bindCell(c.iso) : undefined;
            const isDropTarget =
              dragReschedule.state.draggingId !== null &&
              dragReschedule.state.hoverIso === c.iso;
            // Family events for this cell — show the first event's emoji
            // (or 🎂 fallback) in the top-right so the user can spot
            // birthdays/anniversaries at a glance on the month grid.
            // The full list lands in the day list on tap.
            const eventsHere = c.dim ? [] : eventsByMonthDay.get(monthDayOf(c.iso)) ?? [];
            const eventGlyph =
              eventsHere.length > 0 ? eventsHere[0]?.emoji ?? '🎂' : null;
            return (
              <div
                key={i}
                className={cls.join(' ')}
                onClick={() => !c.dim && handleCellTap(c.iso)}
                onPointerEnter={cellBind?.onPointerEnter}
                onPointerLeave={cellBind?.onPointerLeave}
                style={{
                  cursor: c.dim ? 'default' : 'pointer',
                  userSelect: 'none',
                  position: 'relative',
                  ...(isDropTarget
                    ? {
                        outline: '2px solid var(--ink)',
                        outlineOffset: -2,
                        background: 'var(--faint)',
                      }
                    : null),
                }}
              >
                <span className="n">{c.n}</span>
                {eventGlyph && (
                  <span
                    aria-hidden
                    style={{
                      position: 'absolute',
                      top: 2,
                      right: 4,
                      fontSize: 10,
                      lineHeight: 1,
                      pointerEvents: 'none',
                    }}
                  >
                    {eventGlyph}
                  </span>
                )}
                <span className="dots">
                  {shown.map((o) => (
                    <Dot
                      key={o.id}
                      m={o.assigneeId ? memberById.get(o.assigneeId) ?? null : null}
                      done={o.status === 'done'}
                    />
                  ))}
                  {more > 0 && <span className="more">+{more}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Filter Seg — Все / Мои / <member>. Same shape as Day so the user
          can stay in their preferred view as they switch screens. Affects
          both the day list and the dots on the month grid. */}
      {members.length > 1 && (
        <Seg items={filterItems} active={filter} onChange={setFilter} />
      )}

      {/* Secondary filter chips — "Не сделанные" / "С фото". These are
          independent toggles (not mutually exclusive like a normal Seg),
          so we reuse `.wf-seg`'s pill styling but add `.on` per-item
          rather than to a single active one. Visually matches the
          author Seg above for consistency. */}
      <div className="wf-seg">
        <span
          className={onlyPending ? 'on' : ''}
          onClick={() => toggleFilter('onlyPending')}
          style={{ cursor: 'pointer' }}
        >
          {t('calendar.filter.pending')}
        </span>
        <span
          className={onlyWithPhoto ? 'on' : ''}
          onClick={() => toggleFilter('onlyWithPhoto')}
          style={{ cursor: 'pointer' }}
        >
          {t('calendar.filter.withPhoto')}
        </span>
      </div>

      {/* Tag filter row — only when the family has at least one tag. Each
          chip is independent (OR semantics: a task matching ANY active
          tag is shown). Tinted with the tag's own colour when active so
          the chip reads as "the tag itself, selected". */}
      {allTags.length > 0 && (
        <div className="wf-row wf-gap-6" style={{ flexWrap: 'wrap' }}>
          {allTags.map((tg) => {
            const active = filterTagIds.includes(tg.id);
            return (
              <button
                key={tg.id}
                type="button"
                onClick={() => toggleTagFilter(tg.id)}
                style={{
                  background: active ? tg.color ?? 'var(--ink)' : 'transparent',
                  color: active ? 'var(--paper)' : 'var(--ink)',
                  border: `1.5px solid ${active ? tg.color ?? 'var(--ink)' : 'var(--line)'}`,
                  borderRadius: 999,
                  padding: '4px 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  font: 'inherit',
                  lineHeight: 1.2,
                }}
              >
                {tg.name}
              </button>
            );
          })}
        </div>
      )}

      {/* Month view: selected-day heading + list. Week / Agenda render
          their own day-grouped sections below; everything from the
          heading down through the done-collapsible belongs to month
          mode only. */}
      {viewMode === 'month' && (<>
      <div
        className="wf-spread"
        style={{ marginTop: 4, cursor: onOpenDay ? 'pointer' : undefined }}
        onClick={() => onOpenDay?.(selectedIso)}
      >
        <span className="wf-h2">{dayHeading}</span>
        <span className="wf-hint">{daySub}</span>
      </div>

      {occurrencesQuery.isLoading && <span className="wf-hint">{t('common.loading')}</span>}
      {!occurrencesQuery.isLoading && occurrences.length === 0 && (
        // The FAB pill at the bottom already exposes "+ Добавить задачу", so
        // we don't duplicate it inside the empty-state card. The hint text
        // points at it ("кнопка «+» внизу") for discoverability.
        <div className="wf-card subtle" style={{ textAlign: 'center', padding: '18px 12px' }}>
          <div style={{ fontSize: 36 }}>📝</div>
          <span className="wf-h2" style={{ display: 'block', marginTop: 8 }}>
            {t('calendar.empty.title')}
          </span>
          <span className="wf-hint" style={{ display: 'block', marginTop: 4 }}>
            {t('calendar.empty.hint')}
          </span>
        </div>
      )}
      {!occurrencesQuery.isLoading &&
        occurrences.length > 0 &&
        selectedOccurrences.length === 0 && (
          <div className="wf-card subtle" style={{ textAlign: 'center', padding: '18px 12px' }}>
            <span className="wf-hint">{t('calendar.day.empty')}</span>
          </div>
        )}
      {members.length === 1 && occurrences.length === 0 && (
        <div
          className="wf-card"
          role={onOpenInvite ? 'button' : undefined}
          tabIndex={onOpenInvite ? 0 : undefined}
          onClick={onOpenInvite}
          onKeyDown={(e) => {
            if (onOpenInvite && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              onOpenInvite();
            }
          }}
          style={{
            borderColor: 'var(--warn)',
            cursor: onOpenInvite ? 'pointer' : 'default',
          }}
        >
          <div className="wf-row wf-gap-8">
            <Icon name="invite" />
            <div className="wf-col" style={{ flex: 1 }}>
              <span className="wf-label">{t('calendar.invite.title')}</span>
              <span className="wf-tiny">{t('calendar.invite.hint')}</span>
            </div>
            {onOpenInvite && <Icon name="chevR" />}
          </div>
        </div>
      )}
      {/* Family events (birthdays etc.) for the selected day. Read-only
          cards above the task list — they recur annually, can't be
          completed/rescheduled like tasks. Computed year-agnostic so
          a Feb 24 birthday appears every year on Feb 24. */}
      {selectedDayEvents.map((ev) => {
        const yearsText =
          ev.year && ev.type === 'birthday'
            ? ` · ${selectedDate.getFullYear() - ev.year}${isEn ? ' yrs' : ' лет'}`
            : '';
        return (
          <div
            key={ev.id}
            className="wf-card"
            style={{ borderColor: 'var(--warn)' }}
          >
            <div className="wf-row wf-gap-10">
              <span style={{ fontSize: 22, flex: 'none' }} aria-hidden>
                {ev.emoji ?? '🎂'}
              </span>
              <div className="wf-col" style={{ flex: 1 }}>
                <span className="wf-label">{ev.title}</span>
                <span className="wf-hint">
                  {t(`events.type.${ev.type}`)}
                  {yearsText}
                </span>
              </div>
            </div>
          </div>
        );
      })}
      {/* Pending tasks for the selected day. Draggable to any other
          calendar cell to reschedule. Floating + forecast rows are
          skipped — they have no real date to move. */}
      {selectedPending.map((o) => {
        const isFloating = o.task.type === 'floating' || o.scheduledDate === null;
        const isForecast = o.id.startsWith('queue-forecast:');
        const draggable = !isFloating && !isForecast;
        return (
          <DayTaskCard
            key={o.id}
            meId={me.id}
            o={o}
            memberById={memberById}
            selectedIso={selectedIso}
            todayIso={todayIso}
            onOpenTask={onOpenTask}
            onToggle={(occ) => {
              if (occ.status === 'done') uncompleteMut.mutate(occ.id);
              else completeMut.mutate(occ.id);
            }}
            dragBinding={
              !selectMode && draggable
                ? dragReschedule.bindCard(o.id, o.scheduledDate, () =>
                    onOpenTask?.(o),
                  )
                : undefined
            }
            selectionState={
              selectMode
                ? {
                    selected: selectedIds.has(o.id),
                    onToggle: () => toggleSelected(o.id),
                  }
                : undefined
            }
          />
        );
      })}

      {/* Done tasks — collapsed by default (matches Day screen UX). */}
      {selectedDone.length > 0 && (
        <div
          className="wf-card subtle"
          style={{ marginTop: 2, cursor: 'pointer' }}
          onClick={() => setShowDone(!showDone)}
        >
          <div className="wf-spread">
            <span className="wf-row wf-gap-6">
              <Icon name="check" />
              <span className="wf-label">
                {t('calendar.done.collapsed')} · {selectedDone.length}
              </span>
            </span>
            <Icon name={showDone ? 'chevD' : 'chevR'} />
          </div>
        </div>
      )}
      {showDone &&
        selectedDone.map((o) => (
          <DayTaskCard
            key={o.id}
            meId={me.id}
            o={o}
            memberById={memberById}
            selectedIso={selectedIso}
            todayIso={todayIso}
            onOpenTask={onOpenTask}
            onToggle={(occ) => uncompleteMut.mutate(occ.id)}
          />
        ))}
      </>)}

      {viewMode === 'week' && (
        <WeekView
          anchor={selectedIso || todayIso}
          byDate={byDate}
          memberById={memberById}
          todayIso={todayIso}
          meId={me.id}
          onOpenTask={onOpenTask}
          onOpenDay={onOpenDay}
          onToggle={(occ) => {
            if (occ.status === 'done') uncompleteMut.mutate(occ.id);
            else completeMut.mutate(occ.id);
          }}
          isEn={isEn}
          t={t}
        />
      )}

      {viewMode === 'agenda' && (
        <AgendaView
          occurrences={occurrences}
          memberById={memberById}
          todayIso={todayIso}
          meId={me.id}
          onOpenTask={onOpenTask}
          onOpenDay={onOpenDay}
          onToggle={(occ) => {
            if (occ.status === 'done') uncompleteMut.mutate(occ.id);
            else completeMut.mutate(occ.id);
          }}
          isEn={isEn}
          t={t}
        />
      )}

      {/* "Когда-нибудь" — floating + queued tasks without a scheduled date.
         Port of CalV1 :131-135. The dateless rollup respects the same
         member filter as the day list: pass the user id when the active
         filter is "Мои" or a specific member; pass `undefined` for "Все"
         so all floating tasks show. */}
      <FloatingSection
        tasks={tasksQuery.data?.tasks ?? []}
        occurrences={occurrences}
        memberById={memberById}
        meId={me.id}
        onOpen={(o) => onOpenTask?.(o)}
        onComplete={(o) => completeMut.mutate(o.id)}
        filterUserId={
          filter === ALL_LBL
            ? undefined
            : filter === MINE_LBL
              ? me.id
              : members.find((m) => m.name === filter)?.id
        }
      />

      {/* Add-task pill — centered above the bottom-nav. Replaced by
          a Bulk-action bar when select-mode is on. */}
      {selectMode ? (
        <div
          className="wf-fab"
          role="region"
          aria-label="bulk actions"
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            padding: '8px 16px',
          }}
        >
          <button
            type="button"
            onClick={clearSelection}
            disabled={bulkCompleteMut.isPending}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--paper)',
              cursor: 'pointer',
              padding: 4,
              opacity: 0.85,
            }}
          >
            ✕ {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() =>
              selectedIds.size > 0 &&
              bulkCompleteMut.mutate(Array.from(selectedIds))
            }
            disabled={selectedIds.size === 0 || bulkCompleteMut.isPending}
            style={{
              background: 'var(--paper)',
              color: 'var(--ink)',
              border: 'none',
              borderRadius: 999,
              padding: '6px 14px',
              fontWeight: 600,
              cursor:
                selectedIds.size === 0 || bulkCompleteMut.isPending
                  ? 'default'
                  : 'pointer',
              marginLeft: 'auto',
            }}
          >
            ✓ {t('bulk.complete')} ({selectedIds.size})
          </button>
        </div>
      ) : (
        <div
          className="wf-fab"
          onClick={() => onCreateTask?.(selectedIso)}
          role="button"
          aria-label={t('calendar.fab')}
        >
          <span className="wf-fab__plus">+</span>
          <span>{t('calendar.fab')}</span>
          {/* Quick toggle to enter select-mode. Stop propagation so the
              parent FAB click (which creates a task) doesn't also fire. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setSelectMode(true);
            }}
            aria-label={t('bulk.enterSelect')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--paper)',
              cursor: 'pointer',
              padding: 4,
              marginLeft: 8,
              opacity: 0.7,
            }}
          >
            ☑
          </button>
        </div>
      )}
    </WfBody>
  );
}

/** Single task row inside the Calendar's selected-day list. Extracted so both
 *  the pending and the (collapsed) done branches render identically. */
function DayTaskCard({
  o,
  memberById,
  selectedIso,
  todayIso,
  meId,
  onOpenTask,
  onToggle,
  dragBinding,
  selectionState,
}: {
  o: OccurrenceDto;
  memberById: Map<string, Member>;
  selectedIso: string;
  todayIso: string;
  /** Current user's id. Drives the "ownership-only" gate on the
   *  checkbox — the user explicitly asked that you cannot complete
   *  someone else's task from the day list. Unassigned (shared)
   *  rows stay tappable. */
  meId: string;
  onOpenTask?: (occurrence: OccurrenceDto) => void;
  onToggle: (occurrence: OccurrenceDto) => void;
  /** Optional drag-to-reschedule binding from useDragReschedule. The
   *  hook returns null/undefined for cards that aren't eligible (e.g.
   *  done rows, forecast rows) — we skip wiring in those cases. */
  dragBinding?: {
    onPointerDown: (e: React.PointerEvent) => void;
    style: React.CSSProperties;
  };
  /** When set, the card renders in select-mode: a leading round
   *  checkbox replaces the normal one, the row's onClick toggles
   *  selection (instead of opening the task), and the strict-tap path
   *  through `dragBinding.onTap` also selects rather than opens. */
  selectionState?: { selected: boolean; onToggle: () => void };
}) {
  const t = useT();
  const isEn = t.locale === 'en';
  const assignee = o.assigneeId ? memberById.get(o.assigneeId) ?? null : null;
  const done = o.status === 'done';
  // `completedBy` is still used by the subtitle ("by Anna · +5") — we
  // just no longer drive the checkbox colour from it. Per user
  // request, done rows always get a neutral grey checkbox so a done
  // not-mine task doesn't look "still actionable" via the completer's
  // brand colour. Day.tsx mirrors this rule.
  const completedBy = done && o.completedBy ? memberById.get(o.completedBy) ?? null : null;
  const doneBg = done ? 'var(--softline)' : null;
  const doneFg = doneBg ? pickInkOrPaper(doneBg) : 'var(--paper)';
  const photoBlocked = o.task.photoRequired && !done;
  // Forecast rows are predictions of future queue rotations — there's no
  // real occurrence in the DB yet, so completing/opening them would 404.
  // Render them dimmed and non-interactive; the user sees the schedule
  // but can only act on the real "today" row.
  const isForecast = o.id.startsWith('queue-forecast:');
  // Checkboxes removed by user request — they were "только мешают".
  // Completion now flows through TaskSheet: tap the row → sheet opens
  // → press "Выполнить". Keep `meId`/`onToggle` in the prop signature
  // so callers don't need to change; just mark them unused locally.
  void meId;
  void onToggle;
  void photoBlocked;
  void doneFg;
  void doneBg;
  return (
    <div
      className="wf-card"
      // When `dragBinding` is provided, the hook owns tap-vs-drag and
      // calls our `onTap` callback on a pure tap; we suppress the
      // native onClick so we don't double-fire onOpenTask.
      onClick={
        selectionState
          ? () => selectionState.onToggle()
          : dragBinding
            ? undefined
            : () => !isForecast && onOpenTask?.(o)
      }
      onPointerDown={selectionState ? undefined : dragBinding?.onPointerDown}
      style={{
        cursor:
          selectionState || (!isForecast && onOpenTask) ? 'pointer' : 'default',
        opacity: isForecast ? 0.55 : 1,
        ...(selectionState?.selected
          ? { outline: '2px solid var(--ink)', outlineOffset: -2 }
          : null),
        ...(dragBinding?.style ?? null),
      }}
    >
      {selectionState && (
        <div
          className="wf-row wf-gap-6"
          style={{ marginBottom: 4, alignItems: 'center' }}
        >
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: 4,
              border: '1.5px solid var(--ink)',
              background: selectionState.selected ? 'var(--ink)' : 'transparent',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--paper)',
              fontSize: 11,
              flex: 'none',
            }}
          >
            {selectionState.selected ? '✓' : ''}
          </span>
        </div>
      )}
      <div className="wf-row wf-gap-10">
        <span
          className="wf-mc"
          style={{
            width: 4,
            height: 28,
            background: assignee?.color ?? 'var(--softline)',
            borderRadius: 2,
            opacity: done ? 0.5 : 1,
          }}
        />
        <div className="wf-col" style={{ flex: 1 }}>
          <span
            className="wf-label"
            style={done ? { textDecoration: 'line-through', color: 'var(--hint)' } : undefined}
          >
            {o.task.title}
          </span>
          <span className="wf-hint">
            {done && completedBy
              ? `${isEn ? 'by ' : ''}${completedBy.name}${o.pointsAwarded ? ` · +${o.pointsAwarded}` : ''}`
              : taskSub(o, assignee, isEn)}
          </span>
        </div>
        {tagForOccurrence(o, done, selectedIso, todayIso, isEn)}
      </div>
    </div>
  );
}

type Cell = { n: number; iso: string; dim: boolean };

function makeMonthCells(month: Date): Cell[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const dow = (first.getDay() + 6) % 7; // Mon=0..Sun=6
  const start = new Date(first);
  start.setDate(first.getDate() - dow);
  const cells: Cell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push({
      n: d.getDate(),
      iso: toIso(d),
      dim: d.getMonth() !== month.getMonth(),
    });
  }
  return cells;
}

function taskSub(o: OccurrenceDto, assignee: Member | null, isEn: boolean): string {
  const parts: string[] = [];
  if (assignee) parts.push(assignee.name);
  if (o.task.type === 'recurring') parts.push(isEn ? 'recurring' : 'повтор');
  else if (o.scheduledTime) parts.push(`${isEn ? 'by' : 'до'} ${o.scheduledTime.slice(0, 5)}`);
  if (o.task.points > 0) parts.push(`+${o.task.points}`);
  return parts.join(' · ');
}

function tagForOccurrence(
  o: OccurrenceDto,
  done: boolean,
  selectedIso: string,
  todayIso: string,
  isEn: boolean,
): JSX.Element | null {
  if (done) return null;
  // Past day with pending occurrence → red countdown chip
  if (selectedIso < todayIso) {
    return <Tag variant="danger">{isEn ? 'overdue' : 'просрочено'}</Tag>;
  }
  // Today with a scheduled time within 3h → warn ⏰
  if (selectedIso === todayIso && o.scheduledTime) {
    const [hh, mm] = o.scheduledTime.slice(0, 5).split(':').map(Number);
    if (hh != null && mm != null) {
      const due = new Date();
      due.setHours(hh, mm, 0, 0);
      const diffH = (due.getTime() - Date.now()) / 3_600_000;
      if (diffH >= 0 && diffH <= 3) {
        const h = Math.max(0, Math.ceil(diffH));
        return <Tag variant="warn">⏰ {h} {isEn ? 'h' : 'ч'}</Tag>;
      }
    }
  }
  if (o.task.photoRequired) {
    return (
      <Tag>
        <Icon name="cam" />
      </Tag>
    );
  }
  if (o.task.type === 'recurring') return <Tag>{isEn ? 'Recurring' : 'Повтор'}</Tag>;
  return null;
}

function pluralTaskI18n(n: number, isEn: boolean): string {
  return pluralize(
    isEn ? 'en' : 'ru',
    n,
    ['задача', 'задачи', 'задач'],
    ['task', 'tasks'],
  );
}


/**
 * Week view — 7 expanded day rows for the week containing the anchor
 * date. Each row carries its own header (day name + ordinal) and the
 * tasks for that day inline. Reuses `byDate` from the month-wide fetch
 * so we don't reissue a query when toggling between Month and Week
 * (both views look at the same range; Week just lays it out vertically).
 */
function WeekView({
  anchor,
  byDate,
  memberById,
  todayIso,
  meId,
  onOpenTask,
  onOpenDay,
  onToggle,
  isEn,
  t,
}: {
  anchor: string;
  byDate: Map<string, OccurrenceDto[]>;
  memberById: Map<string, Member>;
  todayIso: string;
  /** Current user id — forwarded into DayTaskCard for the ownership
   *  gate on the inline checkbox. */
  meId: string;
  onOpenTask?: (occurrence: OccurrenceDto) => void;
  onOpenDay?: (iso: string) => void;
  onToggle: (o: OccurrenceDto) => void;
  isEn: boolean;
  t: ReturnType<typeof useT>;
}) {
  const days = useMemo(() => {
    const d = new Date(`${anchor}T00:00:00`);
    // ISO week: Monday-based. Roll back to Monday.
    const dow = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dow);
    const out: string[] = [];
    for (let i = 0; i < 7; i++) {
      const di = new Date(d);
      di.setDate(d.getDate() + i);
      out.push(toIso(di));
    }
    return out;
  }, [anchor]);
  return (
    <div className="wf-col" style={{ gap: 8 }}>
      {days.map((iso) => {
        const occ = byDate.get(iso) ?? [];
        const pending = occ.filter((o) => o.status !== 'done');
        const done = occ.filter((o) => o.status === 'done');
        return (
          <div key={iso} className="wf-col" style={{ gap: 4 }}>
            <div
              className="wf-spread"
              style={{ marginTop: 2, cursor: onOpenDay ? 'pointer' : undefined }}
              onClick={() => onOpenDay?.(iso)}
            >
              <span className="wf-h3" style={iso === todayIso ? { color: 'var(--ink)' } : { color: 'var(--hint)' }}>
                {fmtDayLabel(iso, todayIso, isEn)}
              </span>
              <span className="wf-tiny">
                {occ.length
                  ? `${occ.length} ${pluralTaskI18n(occ.length, isEn)}`
                  : isEn
                    ? 'no tasks'
                    : 'нет задач'}
              </span>
            </div>
            {pending.map((o) => (
              <DayTaskCard
                key={o.id}
                meId={meId}
                o={o}
                memberById={memberById}
                selectedIso={iso}
                todayIso={todayIso}
                onOpenTask={onOpenTask}
                onToggle={onToggle}
              />
            ))}
            {done.map((o) => (
              <DayTaskCard
                key={o.id}
                meId={meId}
                o={o}
                memberById={memberById}
                selectedIso={iso}
                todayIso={todayIso}
                onOpenTask={onOpenTask}
                onToggle={onToggle}
              />
            ))}
          </div>
        );
      })}
      <span className="wf-tiny" style={{ display: 'block', textAlign: 'center', marginTop: 4 }}>
        {isEn ? 'For more weeks, switch to Month' : 'Чтобы посмотреть другие недели — переключись на Месяц'}
      </span>
    </div>
  );
}

/**
 * Agenda view — flat forward-looking list. Skips empty days (unlike
 * Week which always shows all 7) so the user sees only what's actually
 * scheduled in the coming weeks. The list is derived from the month
 * fetch + queue forecast; for days past the current month we just
 * surface whatever the parent already loaded.
 */
function AgendaView({
  occurrences,
  memberById,
  todayIso,
  meId,
  onOpenTask,
  onOpenDay,
  onToggle,
  isEn,
  t,
}: {
  occurrences: OccurrenceDto[];
  memberById: Map<string, Member>;
  todayIso: string;
  /** Current user id — forwarded into DayTaskCard for the ownership
   *  gate on the inline checkbox. */
  meId: string;
  onOpenTask?: (occurrence: OccurrenceDto) => void;
  onOpenDay?: (iso: string) => void;
  onToggle: (o: OccurrenceDto) => void;
  isEn: boolean;
  t: ReturnType<typeof useT>;
}) {
  const grouped = useMemo(() => {
    const map = new Map<string, OccurrenceDto[]>();
    for (const o of occurrences) {
      // Agenda is forward-looking — anchor each row by its scheduled
      // date (skip nulls and past days; "Когда-нибудь" lives in its own
      // section, completed history lives on the History screen).
      if (!o.scheduledDate || o.scheduledDate < todayIso) continue;
      if (!map.has(o.scheduledDate)) map.set(o.scheduledDate, []);
      map.get(o.scheduledDate)!.push(o);
    }
    return Array.from(map.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([iso, items]) => ({ iso, items }));
  }, [occurrences, todayIso]);

  if (grouped.length === 0) {
    return (
      <div className="wf-card subtle" style={{ textAlign: 'center', padding: '18px 12px' }}>
        <span className="wf-hint">{t('calendar.agenda.empty')}</span>
      </div>
    );
  }
  return (
    <div className="wf-col" style={{ gap: 8 }}>
      {grouped.map(({ iso, items }) => (
        <div key={iso} className="wf-col" style={{ gap: 4 }}>
          <div
            className="wf-spread"
            style={{ marginTop: 2, cursor: onOpenDay ? 'pointer' : undefined }}
            onClick={() => onOpenDay?.(iso)}
          >
            <span className="wf-h3">{fmtDayLabel(iso, todayIso, isEn)}</span>
            <span className="wf-tiny">
              {items.length} {pluralTaskI18n(items.length, isEn)}
            </span>
          </div>
          {items.map((o) => (
            <DayTaskCard
              key={o.id}
              meId={meId}
              o={o}
              memberById={memberById}
              selectedIso={iso}
              todayIso={todayIso}
              onOpenTask={onOpenTask}
              onToggle={onToggle}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Human-friendly day label for Week + Agenda headers. "Сегодня" for
 *  today, "Завтра" for tomorrow, otherwise "пн, 22 мая" / "Mon, May 22". */
function fmtDayLabel(iso: string, todayIso: string, isEn: boolean): string {
  if (iso === todayIso) return isEn ? 'Today' : 'Сегодня';
  const tomorrow = new Date(`${todayIso}T00:00:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (iso === toIso(tomorrow)) return isEn ? 'Tomorrow' : 'Завтра';
  const d = new Date(`${iso}T00:00:00`);
  const dowShort = isEn ? DOW_SHORT_EN : DOW_SHORT_RU;
  const monthGen = isEn ? MONTH_GENITIVE_EN : MONTH_GENITIVE_RU;
  const w = dowShort[d.getDay()];
  const day = d.getDate();
  const month = monthGen[d.getMonth()];
  return isEn ? `${w}, ${month} ${day}` : `${w}, ${day} ${month}`;
}
