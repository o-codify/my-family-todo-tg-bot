import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
  type OccurrenceDto,
  type RedemptionDto,
  type RewardDto,
} from '../api';
import { Av, Bar, Icon, Seg, Tag, WfBody, type Member } from '../design';
import { PageHeader } from '../components/PageHeader';
import { BottomSheet } from '../components/BottomSheet';
import { pluralize, useT, type TFn } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  /** Burger button → opens the nav drawer. Shown when Shop is reached
   *  directly via the drawer (top-level destination). */
  onOpenDrawer?: () => void;
  /** Back button — shown instead of the burger when reached via in-app
   *  navigation. Exactly one of `onBack`/`onOpenDrawer` is non-null. */
  onBack?: () => void;
};

type ShopTab = 'points' | 'streaks' | 'shop';
type Period = 'week' | 'month' | 'year';

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
 * Port of GameV3 (podium · Очки), GameV2 (streaks · Стрики),
 * and the GameShop reward grid (Магазин) from screens-gamification.jsx
 * and screens-extras.jsx.
 */
export function Shop({ me, family, onOpenDrawer, onBack }: Props) {
  const t = useT();
  const TABS: { id: ShopTab; label: string }[] = [
    { id: 'points', label: t('shop.tab.points') },
    { id: 'streaks', label: t('shop.tab.streaks') },
    { id: 'shop', label: t('shop.tab.shop') },
  ];
  const PERIODS: { id: Period; label: string }[] = [
    { id: 'week', label: t('shop.period.week') },
    { id: 'month', label: t('shop.period.month') },
    { id: 'year', label: t('shop.period.year') },
  ];
  const [tab, setTab] = useState<ShopTab>('points');
  const [period, setPeriod] = useState<Period>('month');
  const queryClient = useQueryClient();

  const todayIso = new Date().toISOString().slice(0, 10);
  const range = useMemo(() => {
    const now = new Date();
    if (period === 'week') {
      const from = new Date(now.getTime() - 7 * 86_400_000);
      return { from: from.toISOString().slice(0, 10), to: todayIso };
    }
    if (period === 'month') {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
      return { from: from.toISOString().slice(0, 10), to: todayIso };
    }
    const from = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    return { from: from.toISOString().slice(0, 10), to: todayIso };
  }, [period, todayIso]);

  const balanceQuery = useQuery({
    queryKey: ['balance', family.id, me.id],
    queryFn: () => api.myBalance(family.id),
  });
  const rewardsQuery = useQuery({
    queryKey: ['rewards', family.id],
    queryFn: () => api.listRewards(family.id),
  });
  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });
  const occurrencesQuery = useQuery({
    queryKey: ['occurrences', family.id, range.from, range.to],
    queryFn: () => api.listOccurrences(family.id, range.from, range.to),
  });
  const tasksQuery = useQuery({
    queryKey: ['tasks', family.id],
    queryFn: () => api.listTasks(family.id),
  });
  // Redemptions across the family. We render the requesting user's own
  // history in the Магазин tab so they have proof the request was
  // recorded; the grant/reject side lives in Inbox for adults.
  const redemptionsQuery = useQuery({
    queryKey: ['redemptions', family.id],
    queryFn: () => api.listRedemptions(family.id),
  });

  const myPts = balanceQuery.data?.points ?? 0;
  const rewards = rewardsQuery.data?.rewards ?? [];
  const rewardById = useMemo(
    () => new Map(rewards.map((r) => [r.id, r])),
    [rewards],
  );
  const members = useMemo(
    () => (membersQuery.data?.members ?? []).map(memberFromDto),
    [membersQuery.data],
  );
  const memberById = useMemo(
    () => new Map(members.map((m) => [m.id, m])),
    [members],
  );
  const occurrences = occurrencesQuery.data?.occurrences ?? [];
  const tasks = tasksQuery.data?.tasks ?? [];
  const myRedemptions = useMemo(
    () =>
      (redemptionsQuery.data?.redemptions ?? [])
        .filter((r) => r.userId === me.id)
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    [redemptionsQuery.data, me.id],
  );

  const redeemMut = useMutation({
    mutationFn: (rewardId: string) => api.redeemReward(family.id, rewardId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['balance', family.id] });
      queryClient.invalidateQueries({ queryKey: ['rewards', family.id] });
      // Without this the new "Pending" row in the user's history doesn't
      // appear immediately — they'd think the redeem silently failed
      // (which is exactly what the user reported).
      queryClient.invalidateQueries({ queryKey: ['redemptions', family.id] });
    },
  });

  // Reward creation. Server check `reward.manage` — Child role gets a
  // 403, but rather than hide the button entirely we let the backend
  // decide and surface its error in the sheet. Most calls are from
  // Owner/Adult, this keeps the UX discoverable.
  const createRewardMut = useMutation({
    mutationFn: (payload: {
      name: string;
      emoji?: string | null;
      description?: string | null;
      costPoints: number;
    }) => api.createReward(family.id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rewards', family.id] });
    },
  });
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <WfBody>
      <PageHeader
        title={t('shop.title')}
        onBack={onBack}
        onOpenDrawer={onOpenDrawer}
        right={
          <span className="wf-tag solid" style={{ fontSize: 14, padding: '4px 10px' }}>
            <Icon name="star" /> {myPts}
          </span>
        }
      />

      <Seg
        items={TABS.map((tt) => tt.label)}
        active={TABS.find((tt) => tt.id === tab)?.label ?? TABS[0]!.label}
        onChange={(v) => {
          const next = TABS.find((tt) => tt.label === v);
          if (next) setTab(next.id);
        }}
        full
      />

      {tab === 'points' && (
        <PointsTab
          me={me}
          members={members}
          occurrences={occurrences}
          tasks={tasks}
          period={period}
          periods={PERIODS}
          onPeriodChange={setPeriod}
          t={t}
        />
      )}

      {tab === 'streaks' && (
        <StreaksTab
          me={me}
          members={members}
          occurrences={occurrences}
          t={t}
        />
      )}

      {tab === 'shop' && (
        <ShopList
          rewards={rewards}
          myPts={myPts}
          loading={rewardsQuery.isLoading}
          onRedeem={(id) => redeemMut.mutate(id)}
          onAdd={() => setCreateOpen(true)}
          error={redeemMut.error as ApiError | null}
          isPending={redeemMut.isPending}
          myRedemptions={myRedemptions}
          rewardById={rewardById}
          memberById={memberById}
          occurrences={occurrences}
          myId={me.id}
          t={t}
        />
      )}

      {createOpen && (
        <CreateRewardSheet
          t={t}
          isPending={createRewardMut.isPending}
          error={createRewardMut.error as ApiError | null}
          onClose={() => {
            createRewardMut.reset();
            setCreateOpen(false);
          }}
          onSubmit={(payload) =>
            createRewardMut.mutate(payload, {
              onSuccess: () => {
                createRewardMut.reset();
                setCreateOpen(false);
              },
            })
          }
        />
      )}
    </WfBody>
  );
}

/* ─── Очки tab — podium + trophies + unfairness ───────── */
function PointsTab({
  me,
  members,
  occurrences,
  tasks,
  period,
  periods,
  onPeriodChange,
  t,
}: {
  me: MeResponse;
  members: Member[];
  occurrences: OccurrenceDto[];
  tasks: { id: string; title: string }[];
  period: Period;
  periods: { id: Period; label: string }[];
  onPeriodChange: (p: Period) => void;
  t: TFn;
}) {
  void me;
  const done = occurrences.filter((o) => o.status === 'done');

  // Points by member from done occurrences
  const ranked = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of members) map.set(m.id, 0);
    for (const o of done) {
      if (o.completedBy && o.pointsAwarded > 0) {
        map.set(o.completedBy, (map.get(o.completedBy) ?? 0) + o.pointsAwarded);
      }
    }
    return members
      .map((m) => ({ m, p: map.get(m.id) ?? 0 }))
      .sort((a, b) => b.p - a.p);
  }, [done, members]);

  const first = ranked[0];
  const second = ranked[1];
  const third = ranked[2];
  const fourth = ranked[3];
  void me;

  // Top tasks → trophies (8 emoji slots)
  const trophies = useMemo(() => {
    const counts = new Map<string, number>();
    for (const o of done) counts.set(o.taskId, (counts.get(o.taskId) ?? 0) + 1);
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const top = Array.from(counts.entries())
      .map(([taskId, count]) => ({
        taskId,
        count,
        title: taskById.get(taskId)?.title ?? '—',
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    return top;
  }, [done, tasks]);
  const trophiesGot = trophies.filter((t) => t.count >= 3).length;

  // Unfairness
  const counts = ranked.map((r) => r.p);
  const maxC = counts[0] ?? 0;
  const minC = counts.filter((c) => c > 0).slice(-1)[0] ?? 0;
  const gap = maxC - minC;
  const ratio = minC > 0 ? maxC / minC : 0;
  const showUnfair = ranked.length >= 2 && gap >= 50;

  return (
    <>
      {/* Period header — port of GameV3 header (screens-gamification.jsx :135-138). */}
      <div className="wf-spread">
        <span className="wf-h2">
          {period === 'week'
            ? t('shop.period.thisWeek')
            : period === 'month'
              ? t('shop.period.thisMonth')
              : t('shop.period.thisYear')}
        </span>
        <Seg
          items={periods.map((p) => p.label)}
          active={periods.find((p) => p.id === period)?.label ?? periods[0]!.label}
          onChange={(v) => {
            const next = periods.find((p) => p.label === v);
            if (next) onPeriodChange(next.id);
          }}
        />
      </div>

      {/* Podium — always shown so the page silhouette matches GameV3 even
          before there are 3 members. 1 member → single tall column with
          crown; 2 → 1st + 2nd; 3+ → full 2-1-3 ranking. */}
      {ranked.length >= 3 && first && second && third && (
        <div
          className="wf-row"
          style={{
            alignItems: 'flex-end',
            justifyContent: 'center',
            gap: 8,
            marginTop: 8,
          }}
        >
          <Pod m={second.m} pts={second.p} height={70} place={2} />
          <Pod m={first.m} pts={first.p} height={100} place={1} crown />
          <Pod m={third.m} pts={third.p} height={48} place={3} />
        </div>
      )}
      {ranked.length === 2 && first && second && (
        <div
          className="wf-row"
          style={{
            alignItems: 'flex-end',
            justifyContent: 'center',
            gap: 8,
            marginTop: 8,
          }}
        >
          <Pod m={first.m} pts={first.p} height={100} place={1} crown />
          <Pod m={second.m} pts={second.p} height={70} place={2} />
        </div>
      )}
      {ranked.length === 1 && first && (
        <div
          className="wf-row"
          style={{
            alignItems: 'flex-end',
            justifyContent: 'center',
            gap: 8,
            marginTop: 8,
          }}
        >
          <Pod m={first.m} pts={first.p} height={100} place={1} crown />
        </div>
      )}

      {/* 4th place card */}
      {fourth && (
        <div className="wf-card">
          <div className="wf-row wf-gap-10">
            <span className="wf-h3" style={{ width: 28 }}>
              4
            </span>
            <Av m={fourth.m} size="sm" />
            <span className="wf-label" style={{ flex: 1 }}>
              {fourth.m.name}
            </span>
            <span className="wf-tag">
              <Icon name="star" />
              &nbsp;{fourth.p}
            </span>
          </div>
        </div>
      )}

      {/* Trophies grid (top tasks) */}
      {trophies.length > 0 && (
        <>
          <div className="wf-spread">
            <span className="wf-h3">{t('shop.trophies.title')}</span>
            <span className="wf-hint">
              {trophiesGot}/{trophies.length}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {trophies.map((t) => (
              <Trophy
                key={t.taskId}
                emoji={pickEmoji(t.title)}
                name={shortTitle(t.title)}
                got={t.count >= 3}
                count={t.count}
              />
            ))}
          </div>
        </>
      )}

      {/* Unfairness */}
      {showUnfair && first && (
        <div className="wf-card subtle">
          <div className="wf-spread">
            <span className="wf-label">{t('shop.unfair.title')}</span>
            <Tag variant="warn">{t('shop.unfair.gap', { gap })}</Tag>
          </div>
          {ratio > 0 && ranked.length > 0 && (
            <span className="wf-hint">
              {t('shop.unfair.ratio', {
                leader: first.m.name,
                ratio: ratio.toFixed(1),
                laggard: ranked[ranked.length - 1]!.m.name,
              })}
            </span>
          )}
        </div>
      )}

      {done.length === 0 && (
        <div className="wf-card subtle" style={{ textAlign: 'center', padding: 18 }}>
          <span className="wf-hint">{t('shop.empty.period')}</span>
        </div>
      )}
    </>
  );
}

function Pod({
  m,
  pts,
  height,
  place,
  crown,
}: {
  m: Member;
  pts: number;
  height: number;
  place: number;
  crown?: boolean;
}) {
  return (
    <div className="wf-col" style={{ alignItems: 'center', flex: 1 }}>
      {crown && <span style={{ fontSize: 22 }}>👑</span>}
      <Av m={m} size="lg" />
      <span className="wf-label" style={{ marginTop: 4 }}>
        {m.name}
      </span>
      <span className="wf-tiny wf-mono">{pts}</span>
      <div
        className="wf-mc"
        style={{
          marginTop: 4,
          width: 60,
          height,
          background: m.color,
          borderRadius: '6px 6px 0 0',
          border: '1.5px solid var(--line)',
          borderBottom: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
          color: '#fff',
        }}
      >
        {place}
      </div>
    </div>
  );
}

function Trophy({
  emoji,
  name,
  got,
  count,
}: {
  emoji: string;
  name: string;
  got: boolean;
  count: number;
}) {
  return (
    <div className="wf-col" style={{ alignItems: 'center', gap: 2 }}>
      <div
        title={`${name} · ${count}×`}
        style={{
          width: 56,
          height: 56,
          borderRadius: 12,
          border: '1.5px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 26,
          background: got ? 'var(--paper)' : 'var(--faint)',
          filter: got ? 'none' : 'grayscale(1) opacity(0.5)',
        }}
      >
        {emoji}
      </div>
      <span className="wf-tiny" style={{ textAlign: 'center' }}>
        {name}
      </span>
    </div>
  );
}

/* ─── Стрики tab — current streak + 21-day calendar + family ─── */
function StreaksTab({
  me,
  members,
  occurrences,
  t,
}: {
  me: MeResponse;
  members: Member[];
  occurrences: OccurrenceDto[];
  t: TFn;
}) {
  const done = occurrences.filter((o) => o.status === 'done');

  const myStreak = useMemo(() => computeStreak(done, me.id), [done, me.id]);
  const familyStreaks = useMemo(
    () =>
      members
        .map((m) => ({ m, s: computeStreak(done, m.id) }))
        .sort((a, b) => b.s.current - a.s.current),
    [done, members],
  );
  const bestEver = Math.max(...familyStreaks.map((x) => x.s.longest), 0);
  const bestEverMember = familyStreaks.find((x) => x.s.longest === bestEver)?.m;

  const daysToBonus = (7 - (myStreak.current % 7)) % 7 || 7;
  const bonusPct = ((myStreak.current % 7) / 7) * 100;

  // 21-day calendar — days going backwards from today
  const today = new Date();
  const days = useMemo(() => {
    const todaySet = new Set<string>();
    for (const o of done) {
      if (o.completedBy !== me.id) continue;
      const d = o.completedAt?.slice(0, 10) ?? o.scheduledDate;
      if (d) todaySet.add(d);
    }
    const out: { iso: string; filled: boolean; today: boolean }[] = [];
    for (let i = 20; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86_400_000);
      const iso = d.toISOString().slice(0, 10);
      out.push({
        iso,
        filled: todaySet.has(iso),
        today: i === 0,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, me.id]);

  return (
    <>
      {/* Current streak hero */}
      <div className="wf-card" style={{ textAlign: 'center', padding: 14 }}>
        <span className="wf-tiny">{t('shop.streak.current')}</span>
        <div
          className="wf-row wf-gap-6"
          style={{ justifyContent: 'center', alignItems: 'baseline', marginTop: 2 }}
        >
          <Icon name="zap" />
          <span className="wf-h1" style={{ fontSize: 48, lineHeight: 1 }}>
            {myStreak.current}
          </span>
          <span className="wf-h3">{pluralDaysI18n(myStreak.current, t.locale === 'en')}</span>
        </div>
        <span className="wf-hint">
          {t('shop.streak.personal')}: {myStreak.longest}
          {bestEverMember && bestEver > 0 &&
            ` · ${t('shop.streak.family')}: ${bestEverMember.name} — ${bestEver}`}
        </span>

        {/* 21-day calendar */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            gap: 4,
            marginTop: 10,
          }}
        >
          {days.map((d) => (
            <div
              key={d.iso}
              title={d.iso}
              style={{
                aspectRatio: '1',
                borderRadius: 6,
                border:
                  '1.5px solid ' + (d.today ? 'var(--ink)' : 'var(--softline)'),
                background: d.filled ? 'var(--ink)' : 'transparent',
              }}
            />
          ))}
        </div>
      </div>

      {/* Family streaks */}
      {familyStreaks.length > 0 && (
        <div className="wf-card">
          <span className="wf-h3">{t('shop.streak.familyTitle')}</span>
          <div className="wf-col wf-gap-6" style={{ marginTop: 6 }}>
            {familyStreaks.map(({ m, s }) => {
              const isRecord = s.longest === bestEver && bestEver > 0;
              return (
                <div key={m.id} className="wf-row wf-gap-8">
                  <Av m={m} size="sm" />
                  <span className="wf-label" style={{ flex: 1 }}>
                    {m.name}
                  </span>
                  <span className="wf-row wf-gap-2">
                    <Icon name="zap" />
                    <span className="wf-label wf-mono">{s.current}</span>
                  </span>
                  {isRecord && <Tag variant="success">{t('shop.streak.record')}</Tag>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Bonus progress */}
      <div className="wf-card subtle">
        <div className="wf-row wf-gap-6">
          <Icon name="award" />
          <span className="wf-label">{t('shop.streak.bonus.title')}</span>
        </div>
        <span className="wf-hint">
          {myStreak.current === 0
            ? t('shop.streak.bonus.start')
            : t('shop.streak.bonus.left', {
                n: daysToBonus,
                units: pluralDaysI18n(daysToBonus, t.locale === 'en'),
              })}
        </span>
        <Bar pct={bonusPct} />
      </div>
    </>
  );
}

/* ─── Магазин tab — reward grid ──────────────────────── */
function ShopList({
  rewards,
  myPts,
  loading,
  onRedeem,
  onAdd,
  error,
  isPending,
  myRedemptions,
  rewardById,
  memberById,
  occurrences,
  myId,
  t,
}: {
  rewards: RewardDto[];
  myPts: number;
  loading: boolean;
  onRedeem: (id: string) => void;
  onAdd: () => void;
  error: ApiError | null;
  isPending: boolean;
  myRedemptions: RedemptionDto[];
  rewardById: Map<string, RewardDto>;
  memberById: Map<string, Member>;
  /** Family-wide occurrences (already-fetched range covers ~14 days back).
   *  Used to estimate "~N tasks until this reward". */
  occurrences: OccurrenceDto[];
  myId: string;
  t: TFn;
}) {
  void memberById;
  if (loading) return <span className="wf-hint">{t('common.loading')}</span>;
  if (rewards.length === 0) {
    return (
      <div className="wf-card subtle" style={{ textAlign: 'center', padding: 18 }}>
        <div style={{ fontSize: 36 }}>🎁</div>
        <span className="wf-h3" style={{ display: 'block', marginTop: 8 }}>
          {t('shop.rewards.empty.title')}
        </span>
        <span className="wf-hint" style={{ display: 'block', marginTop: 4 }}>
          {t('shop.rewards.empty.hint')}
        </span>
        <button
          className="wf-btn primary"
          onClick={onAdd}
          style={{ marginTop: 12, cursor: 'pointer' }}
        >
          + {t('shop.rewards.add')}
        </button>
      </div>
    );
  }

  // Average points-per-task over the last 14 days of MY completions —
  // drives the "~N tasks until this reward" estimate. We skip zero-point
  // completions (giveaway tasks) so the divisor reflects effort, not raw
  // count. Falls back to 1 when there's no recent history yet — the
  // estimate is best-effort, not precise math.
  const cutoffMs = Date.now() - 14 * 86_400_000;
  const myRecentPoints = occurrences.filter(
    (o) =>
      o.status === 'done' &&
      o.completedBy === myId &&
      o.completedAt &&
      new Date(o.completedAt).getTime() >= cutoffMs &&
      o.pointsAwarded > 0,
  );
  const totalPts = myRecentPoints.reduce((s, o) => s + o.pointsAwarded, 0);
  const avgPointsPerTask =
    myRecentPoints.length > 0 ? Math.max(1, totalPts / myRecentPoints.length) : 1;
  const tasksUntil = (reward: RewardDto) =>
    Math.max(0, Math.ceil((reward.costPoints - myPts) / avgPointsPerTask));

  // Two sort modes, the user picks via a small Seg below the headline:
  //   - "cost": affordable first, then ascending price (default — same as before)
  //   - "closest": cheapest gap first, so the "next achievable" reward
  //     sits at the top. Affordable items still come first since their
  //     gap is 0.
  type Sort = 'cost' | 'closest';
  const [sortMode, setSortMode] = useState<Sort>('cost');
  const sorted = [...rewards].sort((a, b) => {
    const aCan = myPts >= a.costPoints ? 0 : 1;
    const bCan = myPts >= b.costPoints ? 0 : 1;
    if (aCan !== bCan) return aCan - bCan;
    if (sortMode === 'closest') {
      return Math.max(0, a.costPoints - myPts) - Math.max(0, b.costPoints - myPts);
    }
    return a.costPoints - b.costPoints;
  });

  // Headline = most expensive locked reward (the "dream") if it exists
  const headline = [...rewards]
    .filter((r) => r.costPoints > myPts)
    .sort((a, b) => b.costPoints - a.costPoints)[0];

  return (
    <>
      {headline && (
        <div className="wf-card" style={{ padding: 12 }}>
          <div className="wf-row wf-gap-10">
            <div
              style={{
                width: 80,
                height: 80,
                borderRadius: 16,
                background: 'var(--faint)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 40,
                border: '1.5px solid var(--line)',
                flex: 'none',
              }}
            >
              {headline.emoji ?? '🎁'}
            </div>
            <div className="wf-col" style={{ flex: 1, minWidth: 0 }}>
              <span className="wf-h3">{headline.name}</span>
              <span className="wf-hint">{t('shop.rewards.dream')}</span>
              <div className="wf-row wf-gap-4" style={{ marginTop: 6 }}>
                <Bar pct={Math.min((myPts / headline.costPoints) * 100, 100)} />
                <span className="wf-tiny wf-mono">
                  {myPts}/{headline.costPoints}
                </span>
              </div>
              <span className="wf-hint" style={{ fontSize: 11, marginTop: 4 }}>
                {t('shop.rewards.remaining', { n: headline.costPoints - myPts })}
                {' · ~'}
                {tasksUntil(headline)} {t('shop.rewards.tasksUntil')}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="wf-spread">
        <span className="wf-hint">{t('shop.rewards.all')}</span>
        <button
          type="button"
          onClick={onAdd}
          className="wf-btn"
          style={{ padding: '4px 10px', fontSize: 13, cursor: 'pointer' }}
        >
          + {t('shop.rewards.add')}
        </button>
      </div>
      {/* Sort mode toggle — cheapest first vs closest-to-goal. Affordable
          items stay on top regardless; the toggle only reorders the
          locked ones. */}
      <Seg
        items={[t('shop.sort.cost'), t('shop.sort.closest')]}
        active={sortMode === 'closest' ? t('shop.sort.closest') : t('shop.sort.cost')}
        onChange={(v) =>
          setSortMode(v === t('shop.sort.closest') ? 'closest' : 'cost')
        }
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {sorted.map((r) => {
          const can = myPts >= r.costPoints;
          return (
            <div
              key={r.id}
              className="wf-card"
              style={{ padding: 10, opacity: can ? 1 : 0.7 }}
            >
              <div style={{ fontSize: 28, lineHeight: 1 }}>{r.emoji ?? '🎁'}</div>
              <div className="wf-label" style={{ marginTop: 4 }}>
                {r.name}
              </div>
              <div className="wf-spread" style={{ marginTop: 6 }}>
                <span className="wf-tag solid">
                  <Icon name="star" />
                  &nbsp;{r.costPoints}
                </span>
                <button
                  className={'wf-btn' + (can ? ' primary' : ' ghost')}
                  onClick={() => can && onRedeem(r.id)}
                  disabled={!can || isPending}
                  style={{
                    padding: '3px 8px',
                    fontSize: 11,
                    cursor: !can || isPending ? 'default' : 'pointer',
                    border: 'none',
                  }}
                >
                  {can ? (isPending ? '…' : t('shop.rewards.take')) : `−${r.costPoints - myPts}`}
                </button>
              </div>
              {!can && (
                // "до приза: ~N задач" — back-of-envelope estimate from
                // the user's last-14-day average. We round up so a non-
                // zero gap never reads as "0 tasks left".
                <span className="wf-tiny" style={{ display: 'block', marginTop: 4, color: 'var(--hint)' }}>
                  ~{tasksUntil(r)} {t('shop.rewards.tasksUntil')}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <div className="wf-card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>
          {(error.body as { error?: string } | null)?.error === 'not_enough_points'
            ? t('shop.rewards.notEnough')
            : error.message}
        </div>
      )}

      {/* User's own redemption history. Without this the user reported
          "забрал приз и он нигде не отображается" — the request lived
          server-side as a pending row but the FE never surfaced it. */}
      {myRedemptions.length > 0 && (
        <>
          <span className="wf-hint" style={{ marginTop: 12 }}>
            {t.locale === 'en' ? 'My requests' : 'Мои запросы'}
          </span>
          <div className="wf-col wf-gap-6">
            {myRedemptions.slice(0, 8).map((r) => {
              const reward = r.rewardId ? rewardById.get(r.rewardId) : null;
              const isEn = t.locale === 'en';
              const label =
                r.status === 'pending'
                  ? isEn
                    ? 'Pending'
                    : 'Ждёт выдачи'
                  : r.status === 'granted'
                    ? isEn
                      ? 'Granted'
                      : 'Выдан'
                    : isEn
                      ? 'Rejected'
                      : 'Отклонён';
              const variant =
                r.status === 'pending'
                  ? ('warn' as const)
                  : r.status === 'granted'
                    ? ('success' as const)
                    : ('danger' as const);
              return (
                <div key={r.id} className="wf-card compact">
                  <div className="wf-row wf-gap-10">
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 8,
                        background: 'var(--faint)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 22,
                        flex: 'none',
                      }}
                    >
                      {reward?.emoji ?? '🎁'}
                    </div>
                    <div className="wf-col" style={{ flex: 1, minWidth: 0 }}>
                      <span
                        className="wf-label"
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {reward?.name ?? (isEn ? 'Removed reward' : 'Приз удалён')}
                      </span>
                      <span className="wf-tiny">
                        {r.costPoints} ⭐ · {fmtRedDate(r.requestedAt, isEn)}
                      </span>
                    </div>
                    <Tag variant={variant}>{label}</Tag>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

function fmtRedDate(iso: string, isEn: boolean): string {
  const d = new Date(iso);
  const monthsRu = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const monthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const months = isEn ? monthsEn : monthsRu;
  const dd = d.getDate();
  const mm = months[d.getMonth()]!;
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return isEn ? `${mm} ${dd}, ${hh}:${mi}` : `${dd} ${mm}, ${hh}:${mi}`;
}

/* ─── Helpers ─────────────────────────────────────── */
function computeStreak(
  done: OccurrenceDto[],
  userId: string,
): { current: number; longest: number } {
  const days = new Set<string>();
  for (const o of done) {
    if (o.completedBy !== userId) continue;
    const d = o.completedAt?.slice(0, 10) ?? o.scheduledDate;
    if (d) days.add(d);
  }
  if (days.size === 0) return { current: 0, longest: 0 };
  const sorted = Array.from(days).sort();

  let longest = 1;
  let cur = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(`${sorted[i - 1]}T00:00:00`);
    const here = new Date(`${sorted[i]}T00:00:00`);
    const diff = Math.round((here.getTime() - prev.getTime()) / 86_400_000);
    if (diff === 1) {
      cur++;
      if (cur > longest) longest = cur;
    } else {
      cur = 1;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  let current = 0;
  const last = sorted[sorted.length - 1];
  if (last !== today && last !== yesterday) {
    current = 0;
  } else {
    current = 1;
    let cursor = new Date(`${last}T00:00:00`);
    for (let i = sorted.length - 2; i >= 0; i--) {
      const prev = new Date(`${sorted[i]}T00:00:00`);
      const diff = Math.round((cursor.getTime() - prev.getTime()) / 86_400_000);
      if (diff === 1) {
        current++;
        cursor = prev;
      } else {
        break;
      }
    }
  }

  return { current, longest };
}

function pickEmoji(title: string): string {
  const t = title.toLowerCase();
  const map: Array<[RegExp, string]> = [
    [/мусор/, '🗑'],
    [/посуд/, '🍽'],
    [/уборк|пылесос|пол/, '🧹'],
    [/корм|собак|кот|кошк|пёс|пес/, '🐾'],
    [/цвет|поли/, '🌱'],
    [/завтрак|обед|ужин|готов/, '🍳'],
    [/стирк/, '🧺'],
    [/урок|школ|домашн/, '📚'],
    [/магазин|закуп|покуп|хлеб|молок/, '🛒'],
    [/душ|зубы|ванн/, '🧼'],
    [/спорт|зарядк|трениров/, '🏋'],
    [/маш|авто/, '🚗'],
    [/чайн|кофе/, '☕'],
  ];
  for (const [rx, e] of map) if (rx.test(t)) return e;
  return '⭐';
}

function shortTitle(t: string): string {
  return t.length <= 8 ? t : t.slice(0, 7) + '…';
}

function pluralDaysI18n(n: number, isEn: boolean): string {
  return pluralize(
    isEn ? 'en' : 'ru',
    n,
    ['день', 'дня', 'дней'],
    ['day', 'days'],
  );
}

/* ─── Create-reward bottom sheet ─────────────────────────
 * Lives here (rather than its own page) because reward creation is a
 * single-form action — name + emoji + cost. The backend gates this on
 * `reward.manage` permission; for users without it we still show the
 * button and surface the 403 inside the sheet as a readable error. */
function CreateRewardSheet({
  t,
  isPending,
  error,
  onClose,
  onSubmit,
}: {
  t: TFn;
  isPending: boolean;
  error: ApiError | null;
  onClose: () => void;
  onSubmit: (payload: {
    name: string;
    emoji?: string | null;
    description?: string | null;
    costPoints: number;
  }) => void;
}) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🎁');
  const [description, setDescription] = useState('');
  const [costPoints, setCostPoints] = useState('50');
  const isEn = t.locale === 'en';
  const trimmedName = name.trim();
  const cost = Number.parseInt(costPoints, 10);
  const canSave =
    trimmedName.length > 0 && Number.isFinite(cost) && cost > 0 && !isPending;

  return (
    <BottomSheet onClose={onClose} zIndex={12}>
      {({ close }) => (
        <>
          
          <div className="wf-row wf-gap-8" style={{ marginBottom: 8 }}>
            <span className="wf-h2" style={{ flex: 1 }}>
              {isEn ? 'New reward' : 'Новый приз'}
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

          {/* Name */}
          <span className="wf-tiny" style={{ display: 'block', marginBottom: 4 }}>
            {isEn ? 'Name' : 'Название'}
          </span>
          <div className="wf-box" style={{ padding: '8px 10px', marginBottom: 10 }}>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              autoFocus
              placeholder={isEn ? 'e.g. Movie night' : 'например, поход в кино'}
              className="wf-label"
              style={{
                width: '100%',
                border: 'none',
                background: 'transparent',
                outline: 'none',
                color: 'var(--ink)',
                font: 'inherit',
              }}
            />
          </div>

          {/* Emoji + cost row */}
          <div className="wf-row wf-gap-8" style={{ marginBottom: 10 }}>
            <div className="wf-col wf-gap-2" style={{ flex: 'none', width: 84 }}>
              <span className="wf-tiny">{isEn ? 'Emoji' : 'Эмодзи'}</span>
              <div className="wf-box" style={{ padding: '8px 10px', textAlign: 'center' }}>
                <input
                  type="text"
                  value={emoji}
                  onChange={(e) => setEmoji(e.target.value.slice(0, 4))}
                  maxLength={4}
                  className="wf-h2"
                  style={{
                    width: '100%',
                    border: 'none',
                    background: 'transparent',
                    outline: 'none',
                    textAlign: 'center',
                    color: 'var(--ink)',
                    font: 'inherit',
                  }}
                />
              </div>
            </div>
            <div className="wf-col wf-gap-2" style={{ flex: 1 }}>
              <span className="wf-tiny">{isEn ? 'Cost (points)' : 'Стоимость (очков)'}</span>
              <div className="wf-box" style={{ padding: '8px 10px' }}>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={costPoints}
                  onChange={(e) => setCostPoints(e.target.value)}
                  className="wf-label"
                  style={{
                    width: '100%',
                    border: 'none',
                    background: 'transparent',
                    outline: 'none',
                    color: 'var(--ink)',
                    font: 'inherit',
                  }}
                />
              </div>
            </div>
          </div>

          {/* Description */}
          <span className="wf-tiny" style={{ display: 'block', marginBottom: 4 }}>
            {isEn ? 'Description (optional)' : 'Описание (необязательно)'}
          </span>
          <div className="wf-box" style={{ padding: '8px 10px', marginBottom: 10 }}>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={240}
              placeholder={isEn ? 'A few words about the prize…' : 'Пара слов о призе…'}
              className="wf-label"
              style={{
                width: '100%',
                border: 'none',
                background: 'transparent',
                outline: 'none',
                resize: 'vertical',
                color: 'var(--ink)',
                font: 'inherit',
              }}
            />
          </div>

          {error && (
            <div
              className="wf-card"
              style={{
                borderColor: 'var(--danger)',
                color: 'var(--danger)',
                marginBottom: 10,
              }}
            >
              {describeRewardError(error, isEn)}
            </div>
          )}

          <div className="wf-row wf-gap-8">
            <button
              className="wf-btn"
              onClick={() => close()}
              style={{ cursor: 'pointer' }}
            >
              {t('common.cancel')}
            </button>
            <button
              className="wf-btn primary"
              disabled={!canSave}
              onClick={() => {
                if (!canSave) return;
                onSubmit({
                  name: trimmedName,
                  emoji: emoji.trim() || null,
                  description: description.trim() || null,
                  costPoints: cost,
                });
              }}
              style={{
                flex: 1,
                cursor: canSave ? 'pointer' : 'not-allowed',
                opacity: canSave ? 1 : 0.5,
              }}
            >
              {isPending ? '…' : t('common.save')}
            </button>
          </div>
        </>
      )}
    </BottomSheet>
  );
}

function describeRewardError(err: ApiError, isEn: boolean): string {
  const body = err.body as { error?: string; permission?: string } | null;
  if (body?.error === 'forbidden') {
    return isEn
      ? 'Your role can’t manage rewards. Ask an adult.'
      : 'Твоя роль не может создавать призы. Попроси взрослого.';
  }
  return err.message;
}


