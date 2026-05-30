import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  type AuditEventDto,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
  type OccurrenceDto,
  type RedemptionDto,
} from '../api';
import { Av, Icon, Seg, Tag, WfBody, type Member } from '../design';
import { PageHeader } from '../components/PageHeader';
import { useT } from '../i18n';

/**
 * One row in the history feed — either a completed task (`occurrence`) or
 * a granted reward redemption (`redemption`). Discriminated union so the
 * renderer can branch on `kind` without losing type info.
 */
type HistoryItem =
  | { kind: 'task'; at: string; userId: string | null; occ: OccurrenceDto }
  | { kind: 'reward'; at: string; userId: string; red: RedemptionDto }
  | { kind: 'change'; at: string; userId: string | null; evt: AuditEventDto };

type Props = {
  me: MeResponse;
  family: FamilySummary;
  /** Back when reached via in-app nav. Mutually exclusive with onOpenDrawer. */
  onBack?: () => void;
  /** Burger when reached via the drawer (top-level entry). */
  onOpenDrawer?: () => void;
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

/** Port of MoreV3 (History) — now a combined feed of completed tasks +
 *  granted reward redemptions, with per-author and per-type filters. */
export function History({ me, family, onBack, onOpenDrawer }: Props) {
  const t = useT();
  const isEn = t.locale === 'en';
  // Author filter (Seg): Все / Мои. Type filter (chips): all / tasks /
  // rewards / with-photo. They're orthogonal so two controls is clearer
  // than one mega-Seg.
  const MINE = t('common.mine');
  const ALL = t('common.everyone');
  const [author, setAuthor] = useState<string>(ALL);
  type TypeFilter = 'all' | 'tasks' | 'rewards' | 'photos' | 'changes';
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const today = new Date();
  const from = new Date(today.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);

  const occurrencesQuery = useQuery({
    queryKey: ['occurrences', family.id, from, to],
    queryFn: () => api.listOccurrences(family.id, from, to),
  });
  const redemptionsQuery = useQuery({
    queryKey: ['redemptions', family.id, 'granted'],
    queryFn: () => api.listRedemptions(family.id, 'granted'),
  });
  const auditQuery = useQuery({
    queryKey: ['audit-log', family.id, from],
    // Match the occurrences window so the timeline is consistent — 90
    // days back is enough for the History page's grouped view.
    queryFn: () =>
      api.listAuditEvents(family.id, {
        from: new Date(`${from}T00:00:00.000Z`).toISOString(),
      }),
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

  const items = useMemo(() => {
    const out: HistoryItem[] = [];
    // Completed tasks → task items.
    if (typeFilter === 'all' || typeFilter === 'tasks' || typeFilter === 'photos') {
      for (const o of occurrencesQuery.data?.occurrences ?? []) {
        if (o.status !== 'done' || !o.completedAt) continue;
        if (typeFilter === 'photos' && (o.photoIds?.length ?? 0) === 0) continue;
        out.push({ kind: 'task', at: o.completedAt, userId: o.completedBy, occ: o });
      }
    }
    // Granted reward redemptions → reward items. We use grantedAt so a
    // request that's still pending doesn't pollute history (the inbox
    // page shows those).
    if (typeFilter === 'all' || typeFilter === 'rewards') {
      for (const r of redemptionsQuery.data?.redemptions ?? []) {
        if (r.status !== 'granted' || !r.grantedAt) continue;
        out.push({ kind: 'reward', at: r.grantedAt, userId: r.userId, red: r });
      }
    }
    // Audit-log events → change items. Surfaces task create/update/
    // delete/restore (and any future entity events the audit log
    // grows) in the same timeline.
    if (typeFilter === 'all' || typeFilter === 'changes') {
      for (const e of auditQuery.data?.events ?? []) {
        out.push({ kind: 'change', at: e.createdAt, userId: e.actorUserId, evt: e });
      }
    }
    // Author filter applies to all kinds — `userId` is the completer for
    // tasks, the requester for rewards, the actor for changes.
    const filtered =
      author === MINE ? out.filter((it) => it.userId === me.id) : out;
    filtered.sort((a, b) => (a.at > b.at ? -1 : 1));
    return filtered;
  }, [
    occurrencesQuery.data,
    redemptionsQuery.data,
    auditQuery.data,
    typeFilter,
    author,
    me.id,
    MINE,
  ]);

  const grouped = useMemo(() => groupByDay(items), [items]);
  const isLoading =
    occurrencesQuery.isLoading ||
    redemptionsQuery.isLoading ||
    auditQuery.isLoading;

  return (
    <WfBody onBack={onBack}>
      <PageHeader title={t('history.title')} onBack={onBack} onOpenDrawer={onOpenDrawer} />
      <Seg items={[ALL, MINE]} active={author} onChange={setAuthor} />

      {/* Type filter Seg — mutually exclusive, so a real `<Seg>` (same
          visual treatment as the author Seg above). We map labels back
          to keys via a lookup since `<Seg>` only carries strings. */}
      {(() => {
        const TYPE_LABELS: Record<TypeFilter, string> = {
          all: t('history.type.all'),
          tasks: t('history.type.tasks'),
          rewards: t('history.type.rewards'),
          photos: t('history.type.photos'),
          changes: t('history.type.changes'),
        };
        const order: TypeFilter[] = ['all', 'tasks', 'rewards', 'photos', 'changes'];
        return (
          <Seg
            items={order.map((k) => TYPE_LABELS[k])}
            active={TYPE_LABELS[typeFilter]}
            onChange={(label) => {
              const found = order.find((k) => TYPE_LABELS[k] === label);
              if (found) setTypeFilter(found);
            }}
          />
        );
      })()}

      {isLoading && <span className="wf-hint">{t('common.loading')}</span>}
      {!isLoading && items.length === 0 && (
        <div className="wf-card subtle" style={{ textAlign: 'center', padding: 18 }}>
          <span className="wf-hint">{t('history.empty')}</span>
        </div>
      )}

      {grouped.map(({ day, items: dayItems }) => (
        <div key={day} className="wf-col" style={{ gap: 8 }}>
          <span className="wf-h3" style={{ marginTop: 4 }}>
            {dayHeading(day, isEn, t)}
          </span>
          {dayItems.map((it) => {
            const m = it.userId ? memberById.get(it.userId) ?? null : null;
            if (it.kind === 'task') {
              const hasPhoto = (it.occ.photoIds?.length ?? 0) > 0;
              return (
                <div key={`task:${it.occ.id}`} className="wf-card">
                  <div className="wf-row wf-gap-10">
                    <Av m={m} size="sm" />
                    <div className="wf-col" style={{ flex: 1 }}>
                      <span className="wf-label">{it.occ.task.title}</span>
                      <span className="wf-hint">
                        {m?.name ?? '—'} · {fmtTime(it.at)}
                      </span>
                    </div>
                    {hasPhoto && (
                      <Tag>
                        <Icon name="cam" />
                      </Tag>
                    )}
                    {it.occ.pointsAwarded > 0 && (
                      // Match the reward row's trailing format ("−N ⭐")
                      // so both kinds of history rows read the same: a
                      // signed point delta followed by the star glyph.
                      <span className="wf-tiny wf-mono">
                        +{it.occ.pointsAwarded} ⭐
                      </span>
                    )}
                  </div>
                </div>
              );
            }
            if (it.kind === 'change') {
              const verb = describeAuditKind(it.evt.kind, t);
              const subject =
                it.evt.entityTitle ?? t('history.change.unknownEntity');
              const changedFields = Array.isArray(
                (it.evt.details as { changedFields?: unknown } | null)
                  ?.changedFields,
              )
                ? ((it.evt.details as { changedFields: string[] }).changedFields)
                : [];
              const detailLine =
                it.evt.kind === 'task.update' && changedFields.length > 0
                  ? `${t('history.change.fields')}: ${changedFields
                      .map((f) => t(`history.change.field.${f}`))
                      .join(', ')}`
                  : null;
              return (
                <div key={`evt:${it.evt.id}`} className="wf-card">
                  <div className="wf-row wf-gap-10">
                    <Av m={m} size="sm" />
                    <div className="wf-col" style={{ flex: 1 }}>
                      <span className="wf-label">
                        {verb}: {subject}
                      </span>
                      <span className="wf-hint">
                        {(m?.name ?? '—') +
                          (detailLine ? ` · ${detailLine}` : '')}{' '}
                        · {fmtTime(it.at)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            }
            // reward row — slightly different shape: title is the prize,
            // meta is "who · when", trailing is "-N ⭐" (spend).
            const prize = it.red.rewardName
              ? `${it.red.rewardEmoji ? it.red.rewardEmoji + ' ' : ''}${it.red.rewardName}`
              : isEn
                ? 'Reward'
                : 'Приз';
            return (
              <div key={`red:${it.red.id}`} className="wf-card">
                <div className="wf-row wf-gap-10">
                  <Av m={m} size="sm" />
                  <div className="wf-col" style={{ flex: 1 }}>
                    <span className="wf-label">{prize}</span>
                    <span className="wf-hint">
                      {m?.name ?? '—'} · {t('history.reward.granted')} · {fmtTime(it.at)}
                    </span>
                  </div>
                  <span className="wf-tiny wf-mono" style={{ color: 'var(--hint)' }}>
                    −{it.red.costPoints} ⭐
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </WfBody>
  );
}

function groupByDay(list: HistoryItem[]): Array<{ day: string; items: HistoryItem[] }> {
  const map = new Map<string, HistoryItem[]>();
  for (const it of list) {
    const day = it.at.slice(0, 10);
    if (!map.has(day)) map.set(day, []);
    map.get(day)!.push(it);
  }
  return Array.from(map.entries())
    .map(([day, items]) => ({ day, items }))
    .sort((a, b) => (a.day > b.day ? -1 : 1));
}

const MONTH_GEN_RU = [
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
const MONTH_GEN_EN = [
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

function dayHeading(iso: string, isEn: boolean, t: ReturnType<typeof useT>): string {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (iso === today) return t('history.today');
  if (iso === yesterday) return t('history.yesterday');
  const d = new Date(`${iso}T00:00:00`);
  const month = (isEn ? MONTH_GEN_EN : MONTH_GEN_RU)[d.getMonth()]!;
  return isEn ? `${month} ${d.getDate()}` : `${d.getDate()} ${month}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Map an audit-event `kind` ("task.create", "task.update", …) to a
 * short localised verb. Unknown kinds fall back to the raw key so a
 * future event type still renders something legible until the
 * translation lands.
 */
function describeAuditKind(kind: string, t: ReturnType<typeof useT>): string {
  switch (kind) {
    case 'task.create':
      return t('history.change.task.create');
    case 'task.update':
      return t('history.change.task.update');
    case 'task.delete':
      return t('history.change.task.delete');
    case 'task.restore':
      return t('history.change.task.restore');
    default:
      return kind;
  }
}
