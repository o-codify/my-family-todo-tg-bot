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
import { usePreferences } from '../hooks/usePreferences';
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

const WK_RU = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const WK_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES_RU = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
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
const MONTH_GENITIVE_RU = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
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
const DOW_SHORT_RU = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
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
  const queueForecast = useMemo(
    () =>
      forecastQueueOccurrences({
        tasks,
        occurrences: rawOccurrences,
        memberIds,
        todayIso,
        toIso: toIsoStr,
      }),
    [tasks, rawOccurrences, memberIds, todayIso, toIsoStr],
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
  };
  const onlyPending = calFilters.onlyPending === true;
  const onlyWithPhoto = calFilters.onlyWithPhoto === true;
  const toggleFilter = (key: 'onlyPending' | 'onlyWithPhoto') => {
    setPrefs({
      calendarFilters: {
        ...calFilters,
        [key]: !calFilters[key],
      },
    });
  };

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
  ]);

  const byDate = useMemo(() => {
    const map = new Map<string, OccurrenceDto[]>();
    for (const o of occurrences) {
      // Anchor logic for null-date rows:
      //   - done                 → the day completedAt landed on
      //   - pending + assigned   → today (someone owes this; show it)
      //   - pending + unassigned → "Когда-нибудь" rollup
      // This covers both queued (always assigned) and floating tasks that
      // were explicitly given to someone.
      let key: string;
      if (o.scheduledDate) {
        key = o.scheduledDate;
      } else if (o.status === 'done' && o.completedAt) {
        key = o.completedAt.slice(0, 10);
      } else if (o.status === 'pending' && o.assigneeId) {
        key = todayIso;
      } else {
        key = '__floating__';
      }
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(o);
    }
    return map;
  }, [occurrences, todayIso]);

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
  const selectedPending = selectedOccurrences.filter((o) => o.status !== 'done');
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
          {families.length > 1 && onSwitchFamily ? (
            <select
              className="wf-h1"
              value={family.id}
              onChange={(e) => onSwitchFamily(e.target.value)}
              style={{ border: 'none', background: 'transparent', color: 'var(--ink)', fontFamily: 'inherit', padding: 0 }}
            >
              {families.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="wf-h1">
              {capitalize(MONTH_NAMES[view.getMonth()] ?? '')} {view.getFullYear()}
            </span>
          )}
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
            const shown = occ.slice(0, 3);
            const more = occ.length - shown.length;
            return (
              <div
                key={i}
                className={cls.join(' ')}
                onClick={() => !c.dim && handleCellTap(c.iso)}
                style={{ cursor: c.dim ? 'default' : 'pointer', userSelect: 'none' }}
              >
                <span className="n">{c.n}</span>
                <span className="dots">
                  {shown.map((o) => (
                    <Dot
                      key={o.id}
                      m={o.assigneeId ? memberById.get(o.assigneeId) ?? null : null}
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
          author Seg above for consistency. Tags slot in here in Phase B. */}
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
      {/* Pending tasks for the selected day. */}
      {selectedPending.map((o) => (
        <DayTaskCard
          key={o.id}
          o={o}
          memberById={memberById}
          selectedIso={selectedIso}
          todayIso={todayIso}
          onOpenTask={onOpenTask}
          onToggle={(occ) => {
            if (occ.status === 'done') uncompleteMut.mutate(occ.id);
            else completeMut.mutate(occ.id);
          }}
        />
      ))}

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
        onOpen={(o) => onOpenTask?.(o)}
        filterUserId={
          filter === ALL_LBL
            ? undefined
            : filter === MINE_LBL
              ? me.id
              : members.find((m) => m.name === filter)?.id
        }
      />

      {/* Add-task pill — centered above the bottom-nav. */}
      <div
        className="wf-fab"
        onClick={() => onCreateTask?.(selectedIso)}
        role="button"
        aria-label={t('calendar.fab')}
      >
        <span className="wf-fab__plus">+</span>
        <span>{t('calendar.fab')}</span>
      </div>
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
  onOpenTask,
  onToggle,
}: {
  o: OccurrenceDto;
  memberById: Map<string, Member>;
  selectedIso: string;
  todayIso: string;
  onOpenTask?: (occurrence: OccurrenceDto) => void;
  onToggle: (occurrence: OccurrenceDto) => void;
}) {
  const t = useT();
  const isEn = t.locale === 'en';
  const assignee = o.assigneeId ? memberById.get(o.assigneeId) ?? null : null;
  const done = o.status === 'done';
  // For done cards: tint the checkbox with the completer's colour so the
  // day list reads "Anna · Misha · Anna · …" at a glance. Same logic as
  // Day.tsx's TaskCard — kept in lockstep so the two surfaces look
  // identical for the same occurrence.
  const completedBy = done && o.completedBy ? memberById.get(o.completedBy) ?? null : null;
  const doneBg = done ? completedBy?.color ?? 'var(--ink)' : null;
  const doneFg = doneBg ? pickInkOrPaper(doneBg) : 'var(--paper)';
  const photoBlocked = o.task.photoRequired && !done;
  // Forecast rows are predictions of future queue rotations — there's no
  // real occurrence in the DB yet, so completing/opening them would 404.
  // Render them dimmed and non-interactive; the user sees the schedule
  // but can only act on the real "today" row.
  const isForecast = o.id.startsWith('queue-forecast:');
  return (
    <div
      className="wf-card"
      onClick={() => !isForecast && onOpenTask?.(o)}
      style={{
        cursor: !isForecast && onOpenTask ? 'pointer' : 'default',
        opacity: isForecast ? 0.55 : 1,
      }}
    >
      <div className="wf-row wf-gap-10">
        {isForecast ? (
          // Placeholder dot instead of a checkbox so the row isn't tap-bait
          // for someone trying to mark a future day done.
          <span
            className="wf-check"
            style={{ pointerEvents: 'none', opacity: 0.4 }}
            aria-hidden
          />
        ) : (
          <span
            className={'wf-check' + (done ? ' done' : '')}
            onClick={(e) => {
              e.stopPropagation();
              if (photoBlocked) {
                onOpenTask?.(o);
                return;
              }
              onToggle(o);
            }}
            style={{
              cursor: 'pointer',
              // Override `.wf-check.done` ink-on-paper when we know the
              // completer — tint to their avatar colour with a contrast-
              // picked glyph so the day list visually identifies WHO
              // closed each row.
              ...(doneBg ? { background: doneBg, color: doneFg, borderColor: doneBg } : null),
            }}
          >
            {done && <Icon name="check" />}
          </span>
        )}
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
  onOpenTask,
  onOpenDay,
  onToggle,
  isEn,
  t,
}: {
  occurrences: OccurrenceDto[];
  memberById: Map<string, Member>;
  todayIso: string;
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
