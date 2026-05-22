import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
  type OccurrenceDto,
} from '../api';
import { Av, Icon, Seg, Tag, WfBody, type Member } from '../design';
import { useT } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  onBack: () => void;
};

function memberFromDto(dto: FamilyMemberDto): Member {
  return {
    id: dto.id,
    name: dto.firstName,
    letter: dto.firstName.slice(0, 1).toUpperCase(),
    color: dto.color,
    role: dto.role.name,
    awayUntil: dto.awayUntil,
  };
}

/** Port of MoreV3 (History) from screens-more.jsx. */
export function History({ me, family, onBack }: Props) {
  const t = useT();
  const isEn = t.locale === 'en';
  const FILTERS = [
    t('common.everyone'),
    t('common.mine'),
    t('history.filter.withPhoto'),
  ] as const;
  const [filter, setFilter] = useState<string>(FILTERS[0]);
  const today = new Date();
  const from = new Date(today.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);

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

  const done = useMemo(() => {
    let list = (occurrencesQuery.data?.occurrences ?? []).filter(
      (o) => o.status === 'done' && o.completedAt,
    );
    if (filter === FILTERS[1]) list = list.filter((o) => o.completedBy === me.id);
    if (filter === FILTERS[2]) list = list.filter((o) => (o.photoIds?.length ?? 0) > 0);
    list.sort((a, b) => (a.completedAt! > b.completedAt! ? -1 : 1));
    return list;
  }, [occurrencesQuery.data, filter, me.id, FILTERS]);

  const grouped = useMemo(() => groupByDay(done), [done]);

  return (
    <WfBody onBack={onBack}>
      <div className="wf-row wf-gap-8">
        <button
          onClick={onBack}
          aria-label={t('common.back')}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--ink)' }}
        >
          <Icon name="chevL" />
        </button>
        <span className="wf-h2" style={{ flex: 1 }}>
          {t('history.title')}
        </span>
      </div>
      <Seg
        items={[...FILTERS]}
        active={filter}
        onChange={(v) => setFilter(v)}
      />

      {occurrencesQuery.isLoading && <span className="wf-hint">{t('common.loading')}</span>}
      {!occurrencesQuery.isLoading && done.length === 0 && (
        <div className="wf-card subtle" style={{ textAlign: 'center', padding: 18 }}>
          <span className="wf-hint">{t('history.empty')}</span>
        </div>
      )}

      {grouped.map(({ day, items }) => (
        <div key={day} className="wf-col" style={{ gap: 8 }}>
          <span className="wf-h3" style={{ marginTop: 4 }}>
            {dayHeading(day, isEn, t)}
          </span>
          {items.map((o) => {
            const m = o.completedBy ? memberById.get(o.completedBy) ?? null : null;
            const hasPhoto = (o.photoIds?.length ?? 0) > 0;
            return (
              <div key={o.id} className="wf-card">
                <div className="wf-row wf-gap-10">
                  <Av m={m} size="sm" />
                  <div className="wf-col" style={{ flex: 1 }}>
                    <span className="wf-label">{o.task.title}</span>
                    <span className="wf-hint">
                      {m?.name ?? '—'} · {fmtTime(o.completedAt!)}
                    </span>
                  </div>
                  {hasPhoto && (
                    <Tag>
                      <Icon name="cam" />
                    </Tag>
                  )}
                  {o.pointsAwarded > 0 && (
                    <span className="wf-tiny wf-mono">+{o.pointsAwarded}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </WfBody>
  );
}

function groupByDay(list: OccurrenceDto[]): Array<{ day: string; items: OccurrenceDto[] }> {
  const map = new Map<string, OccurrenceDto[]>();
  for (const o of list) {
    const day = o.completedAt!.slice(0, 10);
    if (!map.has(day)) map.set(day, []);
    map.get(day)!.push(o);
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
