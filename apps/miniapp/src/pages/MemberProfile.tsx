import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type FamilySummary, type MeResponse } from '../api';
import { Av, Icon, Tag, WfBody } from '../design';
import { useT, type Locale } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  userId: string;
  onBack: () => void;
};

/**
 * Read-only view of another family member. Holds their identity,
 * role, current away/sick status, and a slice of stats so you can
 * see how active they've been. Tapping your own avatar from the
 * member list elsewhere goes to MyProfile instead (the parent
 * decides).
 */
export function MemberProfile({ me, family, userId, onBack }: Props) {
  void me;
  const t = useT();
  const isEn = t.locale === 'en';

  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });
  // Pull stats from the existing endpoint so we don't refetch a custom
  // bag of numbers — just project the member's row out of the family
  // aggregate. `all` period mirrors what the Stats page calls "За всё
  // время".
  const statsQuery = useQuery({
    queryKey: ['stats', family.id, 'all'],
    queryFn: () => api.getStats(family.id, 'all'),
  });

  const dto = membersQuery.data?.members.find((m) => m.id === userId);
  const stats = statsQuery.data;
  const memberStats = useMemo(
    () => stats?.byMember.find((b) => b.userId === userId) ?? null,
    [stats, userId],
  );

  return (
    <WfBody onBack={onBack}>
      <div className="wf-row wf-gap-8">
        <button
          onClick={onBack}
          aria-label={t('common.back')}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            color: 'var(--ink)',
          }}
        >
          <Icon name="chevL" />
        </button>
        <span className="wf-h2" style={{ flex: 1 }}>
          {isEn ? 'Member' : 'Участник'}
        </span>
      </div>

      {!dto && membersQuery.isLoading && (
        <span className="wf-hint">{t('common.loading')}</span>
      )}

      {dto && (
        <>
          {/* Identity */}
          <div className="wf-card" style={{ textAlign: 'center', padding: 14 }}>
            <Av
              m={{
                id: dto.id,
                name: dto.firstName,
                letter: dto.firstName.slice(0, 1).toUpperCase(),
                color: dto.color,
                role: dto.role.name,
                awayUntil: dto.awayUntil,
                awayReason: dto.awayReason,
              }}
              size="xl"
            />
            <div
              className="wf-h3"
              style={{ marginTop: 6, overflowWrap: 'anywhere' }}
            >
              {dto.firstName}
              {dto.lastName && ` ${dto.lastName}`}
            </div>
            {/* Role + away/sick tags. Centered row so it sits under the
                name like a badge bar. */}
            <div
              className="wf-row wf-gap-6"
              style={{ marginTop: 8, justifyContent: 'center', flexWrap: 'wrap' }}
            >
              <Tag>{roleLabel(dto.role.name, t.locale)}</Tag>
              {dto.awayUntil && new Date(dto.awayUntil) > new Date() && (
                <Tag variant="warn">
                  {dto.awayReason === 'sick' ? '🤒' : '🌴'}{' '}
                  {isEn ? 'until' : 'до'} {fmtDate(dto.awayUntil, t.locale)}
                </Tag>
              )}
            </div>
          </div>

          {/* Stats. Lightweight — we already fetch the family aggregate
              for the Stats screen, so reuse it instead of building a
              per-user endpoint. */}
          <div className="wf-card">
            <span className="wf-tiny">
              {isEn ? 'All-time stats' : 'За всё время'}
            </span>
            <div
              className="wf-row wf-gap-10"
              style={{ marginTop: 8, alignItems: 'baseline' }}
            >
              <div className="wf-col" style={{ flex: 1 }}>
                <span className="wf-h2">{memberStats?.count ?? 0}</span>
                <span className="wf-tiny">
                  {isEn ? 'tasks done' : 'задач выполнено'}
                </span>
              </div>
              <div className="wf-col" style={{ flex: 1 }}>
                <span className="wf-h2">
                  <Icon name="star" /> {memberStats?.pointsEarned ?? 0}
                </span>
                <span className="wf-tiny">
                  {isEn ? 'points earned' : 'очков заработано'}
                </span>
              </div>
            </div>
          </div>
        </>
      )}
    </WfBody>
  );
}

function roleLabel(role: string, locale: Locale): string {
  if (locale === 'en') {
    if (role === 'Owner') return 'Owner';
    if (role === 'Adult') return 'Adult';
    if (role === 'Child') return 'Child';
    return role;
  }
  if (role === 'Owner') return 'Владелец';
  if (role === 'Adult') return 'Взрослый';
  if (role === 'Child') return 'Ребёнок';
  return role;
}

function fmtDate(iso: string, locale: Locale = 'ru'): string {
  const d = new Date(iso);
  const monthsRu = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const monthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const months = locale === 'en' ? monthsEn : monthsRu;
  return locale === 'en'
    ? `${months[d.getMonth()]} ${d.getDate()}`
    : `${d.getDate()} ${months[d.getMonth()]}`;
}
