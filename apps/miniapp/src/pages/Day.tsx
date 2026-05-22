import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
  type OccurrenceDto,
  type TaskDto,
} from '../api';
import { Icon, Seg, Tag, WfBody, type Member } from '../design';
import { PageHeader } from '../components/PageHeader';
import { BottomSheet } from '../components/BottomSheet';
import { FloatingSection } from '../components/FloatingSection';
import { pickInkOrPaper } from '../utils/contrast';
import { pluralize, useT } from '../i18n';
import { forecastQueueOccurrences } from '../utils/queueForecast';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  iso: string;
  onBack: () => void;
  onOpenTask: (occurrence: OccurrenceDto) => void;
  onCreateTask: () => void;
};

const DOW_SHORT_RU = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const DOW_SHORT_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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

/** Port of DayV1 (screens-day.jsx lines 4-95) — grouped lists, filter Seg, FAB. */
export function Day({ me, family, iso, onBack, onOpenTask, onCreateTask }: Props) {
  const queryClient = useQueryClient();
  const t = useT();
  const isEn = t.locale === 'en';
  const DOW_SHORT = isEn ? DOW_SHORT_EN : DOW_SHORT_RU;
  const MONTH_GENITIVE = isEn ? MONTH_GENITIVE_EN : MONTH_GENITIVE_RU;
  const date = new Date(`${iso}T00:00:00`);
  const todayIso = new Date().toISOString().slice(0, 10);

  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });
  const occurrencesQuery = useQuery({
    queryKey: ['occurrences', family.id, iso, iso],
    queryFn: () => api.listOccurrences(family.id, iso, iso),
  });
  // For the empty-day "Взять из «Когда-нибудь»" rollup we need the count of
  // floating tasks waiting to be picked up.
  const tasksQuery = useQuery({
    queryKey: ['tasks', family.id],
    queryFn: () => api.listTasks(family.id),
  });

  const completeMut = useMutation({
    mutationFn: (id: string) => api.completeOccurrence(family.id, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] }),
  });
  const uncompleteMut = useMutation({
    mutationFn: (id: string) => api.uncompleteOccurrence(family.id, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] }),
  });

  const members = useMemo(
    () => (membersQuery.data?.members ?? []).map(memberFromDto),
    [membersQuery.data],
  );
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  // The /occurrences API also returns null-date pending rows (so the
  // Calendar can render the "Когда-нибудь" rollup). On the Day screen we
  // explicitly look at *one* day — show only:
  //   - dated rows in this day
  //   - null-date *done* rows whose completedAt matches this day
  //     (this surfaces freshly completed floating tasks)
  //   - null-date pending *queued* rows when viewing today — queue tasks
  //     are intrinsically date-less but only one is "active" at a time,
  //     and the user expects to see their current turn in today's list
  const isToday = iso === todayIso;
  const rawOccurrences = occurrencesQuery.data?.occurrences ?? [];
  const tasks = tasksQuery.data?.tasks ?? [];

  // Queue forecast: if this day is in the future, project who's up by
  // cadence (cooldownDays || 1) so the user sees rotations ahead. The
  // forecast generator emits one row per task at iso === this day if
  // the rotation lands here. See utils/queueForecast.ts.
  const memberIds = useMemo(() => members.map((m) => m.id), [members]);
  const forecastedQueue = useMemo(() => {
    if (iso <= todayIso) return [];
    return forecastQueueOccurrences({
      tasks,
      occurrences: rawOccurrences,
      memberIds,
      todayIso,
      toIso: iso,
    }).filter((o) => o.scheduledDate === iso);
  }, [tasks, rawOccurrences, memberIds, todayIso, iso]);

  const occurrences = [
    ...rawOccurrences.filter((o) => {
      if (o.scheduledDate !== null) return true;
      if (o.status === 'done') {
        if (!o.completedAt) return false;
        return o.completedAt.slice(0, 10) === iso;
      }
      // null-date pending with an assignee: surface on today's view.
      // Mirrors the Calendar anchor — assigned dateless tasks shouldn't
      // disappear into "Когда-нибудь" while someone owes them.
      if (isToday && o.assigneeId) return true;
      return false;
    }),
    ...forecastedQueue,
  ];

  // "Мои" already covers the current user, so don't list them again as a named filter.
  const otherMembers = members.filter((m) => m.id !== me.id);
  const ALL_LBL = t('common.everyone');
  const MINE_LBL = t('common.mine');
  const filterItems: string[] = [ALL_LBL, MINE_LBL, ...otherMembers.map((m) => m.name)];
  const [filter, setFilter] = useState<string>(ALL_LBL);
  const filtered = useMemo(
    () => filterOccurrences(occurrences, filter, me.id, members, ALL_LBL, MINE_LBL),
    [occurrences, filter, me.id, members, ALL_LBL, MINE_LBL],
  );

  const isPast = iso < todayIso;
  // Sort pending tasks by scheduledTime: timed ones first (ascending),
  // time-less ones after. Done tasks stay in completion order (already
  // ordered by createdAt server-side). Stable sort preserves the
  // server's original order within the same time slot.
  const byTimeAsc = (a: OccurrenceDto, b: OccurrenceDto): number => {
    const ta = a.scheduledTime ?? null;
    const tb = b.scheduledTime ?? null;
    if (ta == null && tb == null) return 0;
    if (ta == null) return 1; // time-less goes after timed
    if (tb == null) return -1;
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  };
  const overdue = isPast
    ? [...filtered.filter((o) => o.status === 'pending')].sort(byTimeAsc)
    : [];
  const pending = isPast
    ? []
    : [...filtered.filter((o) => o.status === 'pending')].sort(byTimeAsc);
  const done = filtered.filter((o) => o.status === 'done');

  const [showDone, setShowDone] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Floating tasks ready to pick up right now (not archived and not on cooldown).
  // Cooldown lives on the latest pending occurrence's `availableAt`; the backend
  // rejects completion before that timestamp with HTTP 400, so we filter them
  // out here too — otherwise the user sees a task they can tap but can't do.
  // We use `rawOccurrences` (pre-filter) here because the cooldown info lives
  // on null-date pending rows, which the Day view itself hides.
  const now = Date.now();
  const pendingByTask = useMemo(() => {
    const map = new Map<string, OccurrenceDto>();
    for (const o of rawOccurrences) {
      if (o.status !== 'pending') continue;
      if (!map.has(o.taskId)) map.set(o.taskId, o);
    }
    return map;
  }, [rawOccurrences]);
  const availableFloating = useMemo(
    () =>
      (tasksQuery.data?.tasks ?? []).filter((t) => {
        if (t.type !== 'floating' || t.archivedAt) return false;
        const pending = pendingByTask.get(t.id);
        if (pending?.availableAt && new Date(pending.availableAt).getTime() > now) {
          return false;
        }
        return true;
      }),
    [tasksQuery.data, pendingByTask, now],
  );

  const totalActive = (isPast ? overdue.length : pending.length) + done.length;
  const heading = isEn
    ? `${DOW_SHORT[date.getDay()]}, ${MONTH_GENITIVE[date.getMonth()]} ${date.getDate()}`
    : `${DOW_SHORT[date.getDay()]}, ${date.getDate()} ${MONTH_GENITIVE[date.getMonth()]}`;
  const overduePart = overdue.length
    ? ` · ${overdue.length} ${pluralOverdueI18n(overdue.length, isEn)}`
    : '';
  const sub =
    iso === todayIso
      ? `${t('calendar.today')} · ${totalActive} ${pluralTaskI18nDay(totalActive, isEn)}${overduePart}`
      : `${totalActive} ${pluralTaskI18nDay(totalActive, isEn)}`;

  return (
    <WfBody onBack={onBack}>
      {/* Header — port of lines 7-14. Day is always reached via in-app
          nav (tap a day on Calendar), so we always have a back button —
          no drawer entry exists for "this specific day". */}
      <PageHeader
        title={heading}
        subtitle={sub}
        onBack={onBack}
        right={<Icon name="more" />}
      />

      {/* Filter Seg — port of line 16 */}
      <Seg items={filterItems} active={filter} onChange={setFilter} />

      {/* Overdue group — port of lines 19-33 */}
      {overdue.length > 0 && (
        <>
          <div className="wf-spread" style={{ marginTop: 4 }}>
            <span className="wf-h3" style={{ color: 'var(--danger)' }}>
              {t('day.overdue.title')} · {overdue.length}
            </span>
            <Icon name="chevD" />
          </div>
          {overdue.map((o) => (
            <TaskCard
              key={o.id}
              o={o}
              assignee={o.assigneeId ? memberById.get(o.assigneeId) ?? null : null}
              danger
              onToggle={() => completeMut.mutate(o.id)}
              onOpen={() => onOpenTask(o)}
            />
          ))}
        </>
      )}

      {/* Today group — port of lines 36-82 */}
      {pending.length > 0 && (
        <>
          <span className="wf-h3" style={{ marginTop: 4 }}>
            {iso === todayIso ? t('day.today.section') : t('day.thisday.section')} ·{' '}
            {pending.length}
          </span>
          {pending.map((o) => (
            <TaskCard
              key={o.id}
              o={o}
              assignee={o.assigneeId ? memberById.get(o.assigneeId) ?? null : null}
              onToggle={() => {
                if (o.task.photoRequired) {
                  onOpenTask(o);
                  return;
                }
                completeMut.mutate(o.id);
              }}
              onOpen={() => onOpenTask(o)}
            />
          ))}
        </>
      )}

      {/* Empty state — "Свободный день" CTA from screens-extras (dayEmpty edge).
          Per design (lines 76-85) it has TWO buttons: "+ Добавить на день" and
          "Взять из «Когда-нибудь» (N)" that opens the floating-task picker. */}
      {!occurrencesQuery.isLoading && filtered.length === 0 && (
        <FreeDay
          floatingCount={availableFloating.length}
          onPickFloating={() => setPickerOpen(true)}
        />
      )}

      {/* Floating-task picker — opens when the user taps "Взять из «Когда-нибудь»". */}
      {pickerOpen && (
        <FloatingPicker
          tasks={availableFloating}
          memberById={memberById}
          onClose={() => setPickerOpen(false)}
          onPick={(task) => {
            const synthOcc: OccurrenceDto = {
              id: `floating:${task.id}`,
              taskId: task.id,
              scheduledDate: null,
              scheduledTime: null,
              assigneeId: task.assigneeId,
              status: 'pending',
              subtasks: null,
              completedAt: null,
              completedBy: null,
              photoIds: null,
              pointsAwarded: 0,
              availableAt: null,
              task: {
                id: task.id,
                title: task.title,
                type: task.type,
                points: task.points,
                photoRequired: task.photoRequired,
                deadlineAt: task.deadlineAt,
              },
            };
            setPickerOpen(false);
            onOpenTask(synthOcc);
          }}
        />
      )}

      {/* Done group collapsed — port of lines 84-90 */}
      {done.length > 0 && (
        <div
          className="wf-card subtle"
          style={{ marginTop: 2, cursor: 'pointer' }}
          onClick={() => setShowDone(!showDone)}
        >
          <div className="wf-spread">
            <span className="wf-row wf-gap-6">
              <Icon name="check" />
              <span className="wf-label">
                {t('calendar.done.collapsed')} · {done.length}
              </span>
            </span>
            <Icon name={showDone ? 'chevD' : 'chevR'} />
          </div>
        </div>
      )}
      {showDone &&
        done.map((o) => (
          <TaskCard
            key={o.id}
            o={o}
            assignee={o.assigneeId ? memberById.get(o.assigneeId) ?? null : null}
            completedBy={o.completedBy ? memberById.get(o.completedBy) ?? null : null}
            doneCard
            onToggle={() => uncompleteMut.mutate(o.id)}
            onOpen={() => onOpenTask(o)}
          />
        ))}

      {/* "Когда-нибудь" — same collapsible block as on Calendar. Mirror
          the day's member filter into the rollup: under "Мои" / "<name>"
          only show floating tasks assigned to that person — they don't
          belong to anyone else's filter. */}
      <FloatingSection
        tasks={tasks}
        occurrences={rawOccurrences}
        memberById={memberById}
        onOpen={(o) => onOpenTask(o)}
        filterUserId={
          filter === ALL_LBL
            ? undefined
            : filter === MINE_LBL
              ? me.id
              : members.find((m) => m.name === filter)?.id
        }
      />

      <div className="wf-fab" onClick={onCreateTask} role="button" aria-label={t('day.fab')}>
        <span className="wf-fab__plus">+</span>
        <span>{t('day.fab')}</span>
      </div>
    </WfBody>
  );
}

type CardProps = {
  o: OccurrenceDto;
  assignee: Member | null;
  /** Member who actually completed this occurrence — may differ from
   *  assignee when the task was transferred. Drives the checkbox tint
   *  and the meta line so the user sees WHO finished it at a glance. */
  completedBy?: Member | null;
  danger?: boolean;
  doneCard?: boolean;
  onToggle: () => void;
  onOpen: () => void;
};

function TaskCard({
  o,
  assignee,
  completedBy,
  danger,
  doneCard,
  onToggle,
  onOpen,
}: CardProps) {
  const t = useT();
  const isEn = t.locale === 'en';
  const stripColor = assignee?.color ?? 'var(--softline)';
  // For done cards: tint the checkbox with the completer's colour so the
  // grid reads "Anna · Misha · Anna · …" at a glance. Falls back to ink
  // when we don't know who completed it (e.g. legacy rows without
  // `completedBy`). Mark colour flips based on bg luma so the glyph
  // stays readable across the palette.
  const doneBg = doneCard ? completedBy?.color ?? 'var(--ink)' : null;
  const doneFg = doneBg ? pickInkOrPaper(doneBg) : 'var(--paper)';
  // Forecast rows have a synthetic id — they predict future queue
  // rotations and aren't backed by a real occurrence yet. Render as
  // read-only with dimmed styling.
  const isForecast = o.id.startsWith('queue-forecast:');
  return (
    <div
      className="wf-card"
      style={{
        ...(danger ? { borderColor: 'var(--danger)' } : null),
        ...(isForecast ? { opacity: 0.55, cursor: 'default' } : null),
      }}
      onClick={isForecast ? undefined : onOpen}
    >
      <div className="wf-row wf-gap-10">
        {isForecast ? (
          <span
            className="wf-check"
            style={{ pointerEvents: 'none', opacity: 0.4 }}
            aria-hidden
          />
        ) : (
          <span
            className={'wf-check' + (doneCard ? ' done' : '')}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            style={{
              cursor: 'pointer',
              // Override `.wf-check.done`'s ink background only when we
              // have a completer colour to use; the CSS default keeps
              // applying for the unknown-completer case.
              ...(doneBg ? { background: doneBg, color: doneFg, borderColor: doneBg } : null),
            }}
          >
            {doneCard && <Icon name="check" />}
          </span>
        )}
        <span
          className="wf-mc"
          style={{
            width: 4,
            height: 30,
            background: stripColor,
            borderRadius: 2,
            opacity: doneCard ? 0.5 : 1,
          }}
        />
        <div className="wf-col" style={{ flex: 1 }}>
          <span
            className="wf-label"
            style={doneCard ? { textDecoration: 'line-through', color: 'var(--hint)' } : undefined}
          >
            {o.task.title}
          </span>
          <span className="wf-hint" style={danger ? { color: 'var(--danger)' } : undefined}>
            {doneCard && completedBy
              ? `${isEn ? 'by' : ''} ${completedBy.name}${o.pointsAwarded ? ` · +${o.pointsAwarded}` : ''}`
              : subText(o, assignee, danger, isEn)}
          </span>
          {o.subtasks && o.subtasks.length > 0 && (
            <span className="wf-tiny" style={{ marginTop: 2 }}>
              ✓ {o.subtasks.filter((s) => s.done).length}/{o.subtasks.length}
            </span>
          )}
        </div>
        {tagsFor(o, danger, isEn)}
      </div>
    </div>
  );
}

function subText(
  o: OccurrenceDto,
  assignee: Member | null,
  danger: boolean | undefined,
  isEn: boolean,
): string {
  const parts: string[] = [];
  if (assignee) parts.push(assignee.name);
  if (danger && o.scheduledTime) {
    parts.push(`${isEn ? 'yesterday,' : 'вчера,'} ${o.scheduledTime.slice(0, 5)}`);
  } else if (o.scheduledTime) {
    parts.push(`${isEn ? 'by' : 'до'} ${o.scheduledTime.slice(0, 5)}`);
  }
  if (o.task.points > 0 && !danger) parts.push(`+${o.task.points}`);
  return parts.join(' · ');
}

function tagsFor(
  o: OccurrenceDto,
  danger: boolean | undefined,
  isEn: boolean,
): JSX.Element | null {
  if (danger) return <Tag variant="danger">{isEn ? '−1 d' : '−1 д'}</Tag>;
  if (o.task.type === 'recurring') {
    return (
      <Tag>
        <Icon name="repeat" /> {isEn ? 'recurring' : 'повтор'}
      </Tag>
    );
  }
  if (o.task.photoRequired) {
    return (
      <Tag>
        <Icon name="cam" />
      </Tag>
    );
  }
  return null;
}

function filterOccurrences(
  list: OccurrenceDto[],
  filter: string,
  meId: string,
  members: Member[],
  allLabel: string,
  mineLabel: string,
): OccurrenceDto[] {
  if (filter === allLabel) return list;
  // Match on assignee OR completer so done rows where the user finished
  // someone else's task (or where the task was later transferred) stay
  // visible under their filter. Same rule used on Calendar.
  if (filter === mineLabel) {
    return list.filter((o) => o.assigneeId === meId || o.completedBy === meId);
  }
  const member = members.find((m) => m.name === filter);
  if (member) {
    return list.filter(
      (o) => o.assigneeId === member.id || o.completedBy === member.id,
    );
  }
  return list;
}

/** Port of `DayEmpty` from screens-extras.jsx :62-91. Originally rendered
 *  two CTAs ("+ Добавить на день" + "Взять из «Когда-нибудь» (N)"), but
 *  the "+" duplicated the FAB pill at the bottom of the screen. Now we
 *  only show the "Take from Someday" picker — it's the one action that
 *  isn't available from the FAB. */
function FreeDay({
  floatingCount,
  onPickFloating,
}: {
  floatingCount: number;
  onPickFloating: () => void;
}) {
  const t = useT();
  return (
    <div className="wf-card subtle" style={{ textAlign: 'center', padding: '28px 16px', marginTop: 8 }}>
      <div style={{ fontSize: 40 }}>⛅</div>
      <span className="wf-h2" style={{ display: 'block', marginTop: 8 }}>
        {t('day.free.title')}
      </span>
      <span className="wf-hint" style={{ display: 'block', marginTop: 4 }}>
        {t('day.free.hint')}
      </span>
      {floatingCount > 0 && (
        <button
          className="wf-btn lg block"
          onClick={onPickFloating}
          style={{ marginTop: 16, cursor: 'pointer' }}
        >
          {t('day.free.takeSomeday')} ({floatingCount})
        </button>
      )}
    </div>
  );
}

/** Bottom-sheet that lists floating tasks the user can pick up.
 *  Tapping a row opens the regular TaskSheet (via a synthesized occurrence). */
function FloatingPicker({
  tasks,
  memberById,
  onClose,
  onPick,
}: {
  tasks: TaskDto[];
  memberById: Map<string, Member>;
  onClose: () => void;
  onPick: (task: TaskDto) => void;
}) {
  const t = useT();
  return (
    <BottomSheet onClose={onClose} zIndex={11}>
      {({ close }) => (
        <>
          <div className="handle" />
          <div className="wf-row wf-gap-8" style={{ marginBottom: 8 }}>
            <span className="wf-h2" style={{ flex: 1 }}>
              {t('day.someday.title')}
            </span>
            <button
              onClick={() => close()}
              aria-label={t('common.close')}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                color: 'var(--ink)',
              }}
            >
              <Icon name="x" />
            </button>
          </div>
          <span className="wf-hint">
            {tasks.length === 0 ? t('day.someday.empty') : t('day.someday.hint')}
          </span>
          {tasks.map((ft) => {
            const assignee = ft.assigneeId ? memberById.get(ft.assigneeId) ?? null : null;
            return (
              <div
                key={ft.id}
                className="wf-card"
                onClick={() => close(() => onPick(ft))}
                style={{ cursor: 'pointer' }}
              >
                <div className="wf-row wf-gap-10">
                  <span
                    className="wf-mc"
                    style={{
                      width: 4,
                      height: 28,
                      background: assignee?.color ?? 'var(--softline)',
                      borderRadius: 2,
                    }}
                  />
                  <div className="wf-col" style={{ flex: 1 }}>
                    <span className="wf-label">{ft.title}</span>
                    <span className="wf-hint">
                      {assignee?.name ?? t('day.unassigned')}
                      {ft.cooldownDays
                        ? ` · ${t('queues.detail.everyN', { n: ft.cooldownDays })}`
                        : ''}
                      {ft.points > 0 ? ` · +${ft.points}` : ''}
                    </span>
                  </div>
                  <Icon name="chevR" />
                </div>
              </div>
            );
          })}
        </>
      )}
    </BottomSheet>
  );
}

function pluralTaskI18nDay(n: number, isEn: boolean): string {
  return pluralize(
    isEn ? 'en' : 'ru',
    n,
    ['задача', 'задачи', 'задач'],
    ['task', 'tasks'],
  );
}

function pluralOverdueI18n(n: number, isEn: boolean): string {
  return pluralize(
    isEn ? 'en' : 'ru',
    n,
    ['просрочена', 'просрочены', 'просрочено'],
    ['overdue', 'overdue'],
  );
}
