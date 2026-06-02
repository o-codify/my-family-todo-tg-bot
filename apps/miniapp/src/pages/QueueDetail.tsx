import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
  type OccurrenceDto,
} from '../api';
import { Av, Bar, Icon, Tag, WfBody, type Member } from '../design';
import { PageHeader } from '../components/PageHeader';
import { pluralize, useT } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  taskId: string;
  onBack: () => void;
  /** Open the shared task editor (CreateTaskSheet) for this task. The
   *  parent owns the sheet state so the same "edit" UX serves Day,
   *  Calendar and QueueDetail with no behavioral drift. */
  onEditTask?: (taskId: string) => void;
};

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

/** Port of QueueV2 (screens-queue.jsx lines 77-138). */
export function QueueDetail({ me, family, taskId, onBack, onEditTask }: Props) {
  void me;
  const queryClient = useQueryClient();
  const t = useT();
  const isEn = t.locale === 'en';
  const today = new Date();
  const from = new Date(today.getTime() - 180 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);

  const tasksQuery = useQuery({
    queryKey: ['tasks', family.id],
    queryFn: () => api.listTasks(family.id),
  });
  const occurrencesQuery = useQuery({
    queryKey: ['occurrences', family.id, from, to],
    queryFn: () => api.listOccurrences(family.id, from, to),
  });
  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });

  const completeMut = useMutation({
    mutationFn: (occurrenceId: string) => api.completeOccurrence(family.id, occurrenceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] });
      queryClient.invalidateQueries({ queryKey: ['balance', family.id] });
      // tasks list carries queueStats — must refetch so the balance
      // bars below re-render with the new count.
      queryClient.invalidateQueries({ queryKey: ['tasks', family.id] });
    },
  });


  const members = useMemo(
    () => (membersQuery.data?.members ?? []).map(memberFromDto),
    [membersQuery.data],
  );
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const task = tasksQuery.data?.tasks.find((t) => t.id === taskId);
  const occs = useMemo(
    () => (occurrencesQuery.data?.occurrences ?? []).filter((o) => o.taskId === taskId),
    [occurrencesQuery.data, taskId],
  );
  const pending = occs.find((o) => o.status === 'pending');
  const done = occs.filter((o) => o.status === 'done');

  // Balance is sourced from the task's authoritative queueStats
  // (full history). Earlier we counted `done` rows from the visible
  // 180-day window, which silently dropped older completions and
  // gave wrong totals on long-running queues (user: "у каждого
  // должно быть 1-2, а отображает 0-1; задач выполненных раньше 30
  // нет, а 24, 27, 28 они были"). The local `done` list is still
  // used for the "X times" tag below — that's a total-events
  // count, but per-user we trust the server.
  const allowedIds = task?.queueUserIds ?? members.map((m) => m.id);
  const balance: Record<string, number> = {};
  for (const id of allowedIds) balance[id] = 0;
  const queueStats = task?.queueStats ?? null;
  if (queueStats) {
    for (const [userId, count] of Object.entries(queueStats.completionsByUser)) {
      // Only roster members get a bar; out-of-roster completers (e.g.
      // someone who did the chore once before being removed from the
      // queue) are excluded from the balance display by design.
      if (balance[userId] != null) {
        balance[userId] = count;
      }
    }
  }
  // Total events on this task across all members — read from
  // queueStats so it also covers history beyond the visible window.
  const totalCompletions = queueStats
    ? Object.values(queueStats.completionsByUser).reduce((a, b) => a + b, 0)
    : done.length;
  const sortedIds = Object.keys(balance).sort(
    (a, b) => (balance[a] ?? 0) - (balance[b] ?? 0),
  );
  const currentId = pending?.assigneeId ?? sortedIds[0] ?? null;
  // "Далее" — следующие по балансу. Если кроме текущего никого нет (один в
  // семье), очередь циклится сама на себя, и мы показываем того же участника,
  // чтобы не было пустого «?» / «—».
  const others = sortedIds.filter((id) => id !== currentId);
  const nextIds =
    others.length > 0 ? others.slice(0, 3) : currentId ? [currentId] : [];

  const current = currentId ? memberById.get(currentId) ?? null : null;
  const max = Math.max(1, ...Object.values(balance));
  const minDone = Math.min(...Object.values(balance));
  const maxDone = Math.max(...Object.values(balance));
  const gap = maxDone - minDone;

  const completionsByCurrentSince = pending?.scheduledDate
    ? sinceLabel(new Date(pending.scheduledDate), isEn)
    : isEn
      ? 'since creation'
      : 'с момента создания';

  return (
    <WfBody onBack={onBack}>
      {/* Pencil opens the same CreateTaskSheet used everywhere else —
          delete lives at the bottom-left of that sheet, so all task
          management (rename, cooldown, queue roster, delete) sits in
          one place. */}
      <PageHeader
        title={task?.title ?? '…'}
        onBack={onBack}
        right={
          <button
            type="button"
            onClick={() => onEditTask?.(taskId)}
            disabled={!onEditTask}
            aria-label={t.locale === 'en' ? 'Edit' : 'Изменить'}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: onEditTask ? 'pointer' : 'default',
              padding: 0,
              color: 'var(--ink)',
              opacity: onEditTask ? 1 : 0.4,
            }}
          >
            <Icon name="edit" />
          </button>
        }
      />
      <div className="wf-row wf-gap-6">
        <Tag>
          <Icon name="repeat" />{' '}
          {task?.cooldownDays
            ? t('queues.detail.everyN', { n: task.cooldownDays })
            : t('queues.detail.everyTime')}
        </Tag>
        {task && task.points > 0 && (
          <Tag>
            +{task.points} {t('task.tag.points')}
          </Tag>
        )}
        <Tag>
          {totalCompletions} {t('queues.detail.times')}
        </Tag>
      </div>

      {/* Current big — port of lines 92-101 */}
      <div className="wf-card elevated" style={{ textAlign: 'center', paddingBlock: 16 }}>
        <span className="wf-tiny">{t('queues.now')}</span>
        <div style={{ margin: '8px 0' }}>
          <Av m={current} size="xl" />
        </div>
        <div
          className="wf-h2"
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={current?.name}
        >
          {current?.name ?? '—'}
        </div>
        <span className="wf-hint">{completionsByCurrentSince}</span>
        {/* Action buttons only when the queue is on the current user.
            Other family members see the row read-only — they can't
            mark Zakir's turn as done, that's Zakir's job. */}
        {currentId === me.id && (
          <div
            className="wf-row wf-gap-8"
            style={{ marginTop: 12, justifyContent: 'center' }}
          >
            <span className="wf-btn" title={t('common.soon')}>
              {t('queues.detail.transfer')}
            </span>
            <button
              className="wf-btn primary"
              onClick={() => pending && completeMut.mutate(pending.id)}
              disabled={!pending || completeMut.isPending}
              style={{
                cursor: !pending || completeMut.isPending ? 'default' : 'pointer',
                opacity: !pending || completeMut.isPending ? 0.5 : 1,
              }}
            >
              {completeMut.isPending ? '…' : t('queues.detail.iDid')}
            </button>
          </div>
        )}
      </div>

      {/* Next — port of lines 104-111 */}
      {nextIds.length > 0 && (
        <>
          <span className="wf-hint">{t('queues.detail.next')}</span>
          <div
            className="wf-row wf-gap-8"
            style={{ justifyContent: 'space-between' }}
          >
            {nextIds.map((id, i) => {
              const m = memberById.get(id);
              const away = m?.awayUntil && new Date(m.awayUntil) > new Date();
              return (
                <NextItem key={id} m={m ?? null} pos={String(i + 1)} away={!!away} />
              );
            }).reduce<JSX.Element[]>((acc, el, i) => {
              if (i > 0)
                acc.push(
                  <span key={`arr-${i}`} className="wf-arrow">
                    →
                  </span>,
                );
              acc.push(el);
              return acc;
            }, [])}
          </div>
        </>
      )}

      {/* Balance — port of lines 114-135 */}
      <div className="wf-card">
        <div className="wf-spread">
          <span className="wf-label">{t('queues.detail.who')}</span>
          <Tag>{t('queues.detail.allTime')}</Tag>
        </div>
        <div className="wf-col wf-gap-4" style={{ marginTop: 8 }}>
          {sortedIds.slice().reverse().map((id) => {
            const m = memberById.get(id);
            const v = balance[id] ?? 0;
            return (
              <div key={id} className="wf-row wf-gap-6">
                <Av m={m ?? null} size="xs" />
                <span
                  className="wf-tiny"
                  style={{
                    flex: '0 1 35%',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={m?.name}
                >
                  {m?.name ?? '—'}
                </span>
                <Bar pct={(v / max) * 100} color={m?.color} />
                <span
                  className="wf-tiny wf-mono"
                  style={{ width: 18, textAlign: 'right' }}
                >
                  {v}
                </span>
              </div>
            );
          })}
        </div>
        <div className="wf-row wf-gap-6" style={{ marginTop: 8 }}>
          {gap === 0 ? (
            <span className="wf-tiny" style={{ color: 'var(--success)' }}>
              {t('queues.detail.even')}
            </span>
          ) : (
            <span className="wf-tiny" style={{ color: gap > 4 ? 'var(--warn)' : 'var(--hint)' }}>
              {t('queues.detail.diff', { n: gap })}
            </span>
          )}
        </div>
      </div>
    </WfBody>
  );
}

function NextItem({ m, pos, away }: { m: Member | null; pos: string; away: boolean }) {
  return (
    <div
      className="wf-col"
      style={{ alignItems: 'center', flex: 1, opacity: away ? 0.5 : 1 }}
    >
      <Av m={m} size="lg" />
      <span className="wf-tiny">{m?.name ?? `+${pos}`}</span>
      {away && (
        <span className="wf-tiny" style={{ color: 'var(--warn)' }}>
          🌴
        </span>
      )}
    </div>
  );
}

function sinceLabel(d: Date, isEn: boolean): string {
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return isEn ? 'today' : 'сегодня';
  const month = (isEn ? MONTH_GENITIVE_EN : MONTH_GENITIVE_RU)[d.getMonth()]!;
  const dayLabel = pluralize(
    isEn ? 'en' : 'ru',
    days,
    ['день', 'дня', 'дней'],
    ['day', 'days'],
  );
  return isEn
    ? `since ${month} ${d.getDate()} · ${days} ${dayLabel}`
    : `с ${d.getDate()} ${month} · ${days} ${dayLabel}`;
}
