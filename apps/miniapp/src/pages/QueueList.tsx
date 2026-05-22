import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
  type OccurrenceDto,
  type TaskDto,
} from '../api';
import { Av, Icon, WfBody, type Member } from '../design';
import { PageHeader } from '../components/PageHeader';
import { pluralize, useT } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  onOpenQueue: (taskId: string) => void;
  onCreate: () => void;
  /** Burger button → opens the nav drawer. Top-level page only. */
  onOpenDrawer?: () => void;
  /** Back button (shown instead of the burger when reached via in-app
   *  navigation rather than the drawer). */
  onBack?: () => void;
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

/** Port of QueueV1 (screens-queue.jsx lines 7-23). */
export function QueueList({
  me,
  family,
  onOpenQueue,
  onCreate,
  onOpenDrawer,
  onBack,
}: Props) {
  void me;
  const t = useT();
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

  const members = useMemo(
    () => (membersQuery.data?.members ?? []).map(memberFromDto),
    [membersQuery.data],
  );
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const queues = useMemo(() => {
    const tasks = (tasksQuery.data?.tasks ?? []).filter((t) => t.type === 'queued');
    const occByTask = new Map<string, OccurrenceDto[]>();
    for (const o of occurrencesQuery.data?.occurrences ?? []) {
      if (!occByTask.has(o.taskId)) occByTask.set(o.taskId, []);
      occByTask.get(o.taskId)!.push(o);
    }
    return tasks.map((task) => {
      const occs = occByTask.get(task.id) ?? [];
      const pending = occs.find((o) => o.status === 'pending');
      const done = occs.filter((o) => o.status === 'done');
      const balance: Record<string, number> = {};
      const allowedIds = task.queueUserIds ?? members.map((m) => m.id);
      for (const id of allowedIds) balance[id] = 0;
      for (const d of done) {
        if (d.completedBy && balance[d.completedBy] != null) {
          balance[d.completedBy] = (balance[d.completedBy] ?? 0) + 1;
        }
      }
      const sortedByCompletions = Object.entries(balance).sort(
        ([, a], [, b]) => (a as number) - (b as number),
      );
      const currentId = pending?.assigneeId ?? sortedByCompletions[0]?.[0] ?? null;
      // "Дальше" — следующий по балансу, исключая текущего. Если в семье один
      // участник, очередь циклится «от себя к себе», поэтому показываем того же
      // человека вместо обрубленного «?».
      const remaining = sortedByCompletions
        .map(([id]) => id)
        .filter((id) => id !== currentId);
      const nextId = remaining[0] ?? currentId;
      return { task, currentId, nextId, balance, count: done.length };
    });
  }, [tasksQuery.data, occurrencesQuery.data, members]);

  return (
    <WfBody>
      <PageHeader title={t('queues.title')} onBack={onBack} onOpenDrawer={onOpenDrawer} />
      <span className="wf-hint">
        {queues.length} {pluralQueueTask(queues.length, t.locale === 'en')} · {t('queues.sub')}
      </span>

      {tasksQuery.isLoading && <span className="wf-hint">{t('common.loading')}</span>}
      {!tasksQuery.isLoading && queues.length === 0 && (
        <div className="wf-card subtle" style={{ textAlign: 'center', padding: '18px 12px' }}>
          <div style={{ fontSize: 36 }}>🔄</div>
          <span className="wf-h3" style={{ display: 'block', marginTop: 8 }}>
            {t('queues.empty.title')}
          </span>
          <span className="wf-hint" style={{ display: 'block', marginTop: 4 }}>
            {t('queues.empty.hint')}
          </span>
        </div>
      )}

      {queues.map((q) => (
        <QCard
          key={q.task.id}
          name={q.task.title}
          current={q.currentId ? memberById.get(q.currentId) ?? null : null}
          next={q.nextId ? memberById.get(q.nextId) ?? null : null}
          count={q.count}
          balance={q.balance}
          memberById={memberById}
          onClick={() => onOpenQueue(q.task.id)}
        />
      ))}

      <div className="wf-fab" onClick={onCreate} role="button" aria-label={t('queues.fab')}>
        <span className="wf-fab__plus">+</span>
        <span>{t('queues.fab')}</span>
      </div>
    </WfBody>
  );
}

type QCardProps = {
  name: string;
  current: Member | null;
  next: Member | null;
  count: number;
  balance: Record<string, number>;
  memberById: Map<string, Member>;
  onClick: () => void;
};

/** Port of QCard (screens-queue.jsx lines 26-74). */
function QCard({ name, current, next, count, balance, memberById, onClick }: QCardProps) {
  const t = useT();
  const max = Math.max(1, ...Object.values(balance));
  const ids = Object.keys(balance);
  return (
    <div className="wf-card" onClick={onClick} style={{ cursor: 'pointer' }}>
      <div className="wf-spread">
        <span className="wf-h3">{name}</span>
        <span className="wf-tiny">
          {t('queues.total')} {count}
        </span>
      </div>
      <div className="wf-row" style={{ marginTop: 8, alignItems: 'center' }}>
        <div className="wf-row wf-gap-8" style={{ flex: 1, minWidth: 0 }}>
          <Av m={current} size="lg" />
          <div className="wf-col wf-gap-2" style={{ minWidth: 0, flex: 1 }}>
            <span className="wf-tiny">{t('queues.now')}</span>
            <span
              className="wf-label"
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={current?.name}
            >
              {current?.name ?? t('queues.nobody')}
            </span>
          </div>
        </div>
        <span className="wf-arrow" style={{ padding: '0 10px' }}>
          →
        </span>
        <div className="wf-row wf-gap-8" style={{ flex: 1, minWidth: 0 }}>
          <Av m={next} size="lg" />
          <div className="wf-col wf-gap-2" style={{ minWidth: 0, flex: 1 }}>
            <span className="wf-tiny">{t('queues.next')}</span>
            <span
              className="wf-label"
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={next?.name}
            >
              {next?.name ?? '—'}
            </span>
          </div>
        </div>
      </div>

      <div className="wf-col wf-gap-4" style={{ marginTop: 10 }}>
        <span className="wf-tiny">{t('queues.balance')}</span>
        {ids.map((id) => {
          const m = memberById.get(id);
          const v = balance[id] ?? 0;
          const away = m?.awayUntil && new Date(m.awayUntil) > new Date();
          return (
            <div key={id} className="wf-row wf-gap-6" style={{ opacity: away ? 0.4 : 1 }}>
              <Av m={m ?? null} size="xs" />
              {/* Was a fixed 36px slot that visually clipped long usernames.
                  Now flex-shared with a hard cap so the bar still has room. */}
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
              <span className="wf-bar" style={{ flex: 1 }}>
                <i
                  className="wf-mc"
                  style={{ width: `${(v / max) * 100}%`, background: m?.color ?? 'var(--softline)' }}
                />
              </span>
              {away ? (
                <span className="wf-tiny" style={{ width: 22, textAlign: 'right' }}>
                  🌴
                </span>
              ) : (
                <span
                  className="wf-tiny wf-mono"
                  style={{ width: 22, textAlign: 'right' }}
                >
                  {v}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function pluralQueueTask(n: number, isEn: boolean): string {
  return pluralize(
    isEn ? 'en' : 'ru',
    n,
    ['общая задача', 'общих задачи', 'общих задач'],
    ['shared task', 'shared tasks'],
  );
}
