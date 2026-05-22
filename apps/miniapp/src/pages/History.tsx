import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
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
  | { kind: 'reward'; at: string; userId: string; red: RedemptionDto };

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
  type TypeFilter = 'all' | 'tasks' | 'rewards' | 'photos';
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
    // Author filter applies to both kinds — `userId` is the completer for
    // tasks, the requester for rewards.
    const filtered =
      author === MINE ? out.filter((it) => it.userId === me.id) : out;
    filtered.sort((a, b) => (a.at > b.at ? -1 : 1));
    return filtered;
  }, [
    occurrencesQuery.data,
    redemptionsQuery.data,
    typeFilter,
    author,
    me.id,
    MINE,
  ]);

  const grouped = useMemo(() => groupByDay(items), [items]);
  const isLoading = occurrencesQuery.isLoading || redemptionsQuery.isLoading;

  return (
    <WfBody onBack={onBack}>
      <PageHeader title={t('history.title')} onBack={onBack} onOpenDrawer={onOpenDrawer} />
      <Seg items={[ALL, MINE]} active={author} onChange={setAuthor} />

      {/* Type filter chips — independent of the author Seg above. */}
      <div className="wf-row wf-gap-6" style={{ flexWrap: 'wrap' }}>
        {(
          [
            { key: 'all', label: t('history.type.all') },
            { key: 'tasks', label: t('history.type.tasks') },
            { key: 'rewards', label: t('history.type.rewards') },
            { key: 'photos', label: t('history.type.photos') },
          ] as Array<{ key: TypeFilter; label: string }>
        ).map((c) => {
          const active = typeFilter === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setTypeFilter(c.key)}
              style={{
                background: active ? 'var(--ink)' : 'transparent',
                color: active ? 'var(--paper)' : 'var(--ink)',
                border: `1.5px solid ${active ? 'var(--ink)' : 'var(--line)'}`,
                borderRadius: 999,
                padding: '4px 10px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                font: 'inherit',
                lineHeight: 1.2,
              }}
            >
              {c.label}
            </button>
          );
        })}
      </div>

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
                      <span className="wf-tiny wf-mono">+{it.occ.pointsAwarded}</span>
                    )}
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
