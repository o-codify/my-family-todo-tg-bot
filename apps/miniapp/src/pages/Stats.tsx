import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
} from '../api';
import { Av, Icon, Seg, Tag, WfBody, type Member } from '../design';
import { pluralize, useT } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  onBack?: () => void;
};

type Period = 'week' | 'month' | 'all';

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

/**
 * Stats page — port of StV1 with server-side aggregation.
 *
 * Originally this page pulled every occurrence + every task in the period
 * and computed counts/streaks client-side. That scaled poorly on big
 * families. The heavy lifting now lives in `GET /families/:id/stats`; the
 * client just fetches the small pre-aggregated payload + member metadata
 * for rendering names/colors/avatars.
 */
export function Stats({ me, family, onBack }: Props) {
  const t = useT();
  const isEn = t.locale === 'en';
  const PERIOD_OPTIONS: { id: Period; label: string }[] = [
    { id: 'week', label: t('stats.period.week') },
    { id: 'month', label: t('stats.period.month') },
    { id: 'all', label: t('stats.period.all') },
  ];
  const [period, setPeriod] = useState<Period>('month');

  const statsQuery = useQuery({
    queryKey: ['stats', family.id, period],
    queryFn: () => api.getStats(family.id, period),
    // Stats only refresh once a minute — they're aggregates, not realtime.
    staleTime: 60_000,
  });
  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });

  const members = useMemo(
    () => (membersQuery.data?.members ?? []).map(memberFromDto),
    [membersQuery.data],
  );
  const memberById = useMemo(
    () => new Map(members.map((m) => [m.id, m])),
    [members],
  );

  const stats = statsQuery.data;
  const byMember = stats?.byMember ?? [];
  const maxCount = Math.max(1, ...byMember.map((x) => x.count));
  const total = stats?.total ?? 0;
  const streak = stats?.streaks.me ?? { current: 0, longest: 0 };
  const familyTop = stats?.streaks.familyBest ?? { userId: null, days: 0 };
  const familyTopMember = familyTop.userId ? memberById.get(familyTop.userId) : undefined;
  const topTasks = stats?.topTasks ?? [];

  const ratio = stats?.unfairness.ratio ?? 0;
  const showUnfair =
    members.length >= 2 &&
    ratio >= 1.5 &&
    stats?.unfairness.topUserId &&
    stats?.unfairness.bottomUserId;
  const topMember = stats?.unfairness.topUserId
    ? memberById.get(stats.unfairness.topUserId)
    : undefined;
  const bottomMember = stats?.unfairness.bottomUserId
    ? memberById.get(stats.unfairness.bottomUserId)
    : undefined;

  return (
    <WfBody>
      <div className="wf-row wf-gap-8">
        {onBack && (
          <button
            onClick={onBack}
            aria-label={t('common.back')}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--ink)' }}
          >
            <Icon name="chevL" />
          </button>
        )}
        <span className="wf-h2" style={{ flex: 1 }}>
          {t('stats.title')}
        </span>
        <Seg
          items={PERIOD_OPTIONS.map((p) => p.label)}
          active={PERIOD_OPTIONS.find((p) => p.id === period)?.label ?? PERIOD_OPTIONS[0]!.label}
          onChange={(v) => {
            const next = PERIOD_OPTIONS.find((p) => p.label === v);
            if (next) setPeriod(next.id);
          }}
        />
      </div>

      {/* Кто сколько сделал */}
      <div className="wf-card">
        <div className="wf-spread">
          <span className="wf-h3">{t('stats.byMember')}</span>
          <span className="wf-tiny">
            {total} {t('stats.tasks.count')}
          </span>
        </div>
        <div className="wf-col wf-gap-6" style={{ marginTop: 10 }}>
          {byMember.map(({ userId, count }) => {
            const member = memberById.get(userId);
            return (
              <div key={userId} className="wf-row wf-gap-8">
                <Av m={member ?? null} size="sm" />
                <span className="wf-label" style={{ width: 56, flex: 'none' }}>
                  {member?.name ?? '—'}
                </span>
                <span className="wf-bar" style={{ flex: 1, height: 12 }}>
                  <i
                    className="wf-mc"
                    style={{
                      width: `${(count / maxCount) * 100}%`,
                      background: member?.color ?? 'var(--softline)',
                    }}
                  />
                </span>
                <span
                  className="wf-h3 wf-mono"
                  style={{ width: 36, textAlign: 'right', flex: 'none' }}
                >
                  {count}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Streaks */}
      <div className="wf-row wf-gap-8">
        <div className="wf-card" style={{ flex: 1 }}>
          <span className="wf-tiny">{t('stats.streak.mine')}</span>
          <div className="wf-h2" style={{ marginTop: 2 }}>
            <Icon name="zap" /> {streak.current} {pluralDaysI18n(streak.current, isEn)}
          </div>
          {streak.longest > streak.current && (
            <span className="wf-tiny">
              {t('stats.streak.record')}: {streak.longest}
            </span>
          )}
        </div>
        <div className="wf-card" style={{ flex: 1 }}>
          <span className="wf-tiny">{t('stats.streak.family')}</span>
          <div className="wf-h2" style={{ marginTop: 2 }}>
            {familyTopMember?.name ?? '—'} · {familyTop.days}
          </div>
          <span className="wf-tiny">
            {familyTop.days > 0 ? pluralDaysI18n(familyTop.days, isEn) : ''}
          </span>
        </div>
      </div>

      {/* Top tasks */}
      {topTasks.length > 0 && (
        <div className="wf-card">
          <span className="wf-h3">{t('stats.topTasks')}</span>
          <div className="wf-col wf-gap-4" style={{ marginTop: 6 }}>
            {topTasks.map((tt) => (
              <div key={tt.taskId} className="wf-row wf-gap-8">
                <span style={{ fontSize: 16, width: 22, textAlign: 'center', flex: 'none' }}>
                  📌
                </span>
                <span className="wf-label" style={{ flex: 1 }}>
                  {tt.title}
                </span>
                <span className="wf-tiny wf-mono">{tt.count}×</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unfairness banner */}
      {showUnfair && topMember && bottomMember && topMember.id !== bottomMember.id && (
        <div className="wf-card" style={{ borderColor: 'var(--warn)' }}>
          <div className="wf-spread">
            <div className="wf-row wf-gap-6">
              <Icon name="chart" />
              <span className="wf-label">{t('stats.unfair.title')}</span>
            </div>
            <Tag variant="warn">×{ratio.toFixed(1)}</Tag>
          </div>
          <span className="wf-hint" style={{ display: 'block', marginTop: 4 }}>
            {t('stats.unfair.desc', {
              top: topMember.name,
              ratio: ratio.toFixed(1),
              bottom: bottomMember.name,
            })}
          </span>
        </div>
      )}

      {!statsQuery.isLoading && total === 0 && (
        <div className="wf-card subtle" style={{ textAlign: 'center', padding: 18 }}>
          <span className="wf-hint">{t('stats.empty')}</span>
        </div>
      )}
      {/* unused params kept for parity with prior props */}
      {false && me.id}
    </WfBody>
  );
}

function pluralDaysI18n(n: number, isEn: boolean): string {
  return pluralize(
    isEn ? 'en' : 'ru',
    n,
    ['день', 'дня', 'дней'],
    ['day', 'days'],
  );
}
