import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type FamilySummary, type MeResponse, type PhotoDto } from '../api';
import { Av, Icon, Tag, WfBody } from '../design';
import { PageHeader } from '../components/PageHeader';
import { pluralize, useT, type Locale } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  userId: string;
  /** Always reached via in-app navigation (tap a family member), so back is
   *  the only leading affordance — no drawer entry exists for "a specific
   *  member's profile". */
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

  // Photo gallery — newest first, cap at 60 (server default). For longer
  // histories we'll wire the keyset cursor; 60 covers a few months of
  // photo-verified chores for typical families.
  const photosQuery = useQuery({
    queryKey: ['photos', 'family', family.id, userId],
    queryFn: () => api.listFamilyPhotos(family.id, { userId, limit: 60 }),
  });
  const photos: PhotoDto[] = photosQuery.data?.photos ?? [];

  return (
    <WfBody onBack={onBack}>
      <PageHeader title={isEn ? 'Member' : 'Участник'} onBack={onBack} />

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
              {memberStats && memberStats.streak.current > 0 && (
                <Tag>
                  🔥 {memberStats.streak.current}{' '}
                  {pluralDaysI18n(memberStats.streak.current, isEn)}
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

          {/* Photo gallery — newest-first grid of fotó-reports this member
              attached to completions. Tap → fresh Telegram CDN URL, opened
              full-bleed in a new tab (we don't lightbox-overlay for v1). */}
          {photos.length > 0 && (
            <div className="wf-card">
              <span className="wf-tiny">
                {isEn ? 'Photo reports' : 'Фото-отчёты'}{' '}
                <span className="wf-hint">· {photos.length}</span>
              </span>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 6,
                  marginTop: 8,
                }}
              >
                {photos.map((p) => (
                  <PhotoThumb key={p.id} familyId={family.id} photo={p} />
                ))}
              </div>
            </div>
          )}
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

/**
 * Single thumbnail in the photo gallery. We fetch a fresh Telegram CDN URL
 * lazily — Telegram's URLs expire ~1h, so we don't precompute them in the
 * batch listing. Once loaded, the thumbnail renders inline; tapping opens
 * the full image in a new tab (Telegram WebView intercepts external links
 * fine; lightbox UX can come later).
 */
function PhotoThumb({ familyId, photo }: { familyId: string; photo: PhotoDto }) {
  const urlQuery = useQuery({
    queryKey: ['photo-url', familyId, photo.id],
    queryFn: () => api.getPhotoUrl(familyId, photo.id),
    // Slightly under Telegram's ~1h expiry so we refresh proactively.
    staleTime: 45 * 60 * 1000,
  });
  return (
    <a
      href={urlQuery.data?.url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'block',
        aspectRatio: '1 / 1',
        background: 'var(--faint)',
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid var(--line)',
      }}
    >
      {urlQuery.data?.url ? (
        <img
          src={urlQuery.data.url}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <span style={{ display: 'block', width: '100%', height: '100%' }} />
      )}
    </a>
  );
}

/** "1 день / 2 дня / 5 дней" plural for streak chips. Stats.tsx already
 *  ships an identical helper; copy here keeps this page self-contained
 *  rather than tugging another import across the page boundary. */
function pluralDaysI18n(n: number, isEn: boolean): string {
  return pluralize(isEn ? 'en' : 'ru', n, ['день', 'дня', 'дней'], ['day', 'days']);
}
