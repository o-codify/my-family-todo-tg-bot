import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type FamilySummary, type MeResponse } from '../api';
import { Av, Icon, WfBody } from '../design';
import { BottomSheet } from '../components/BottomSheet';
import { useT, type Locale } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  onBack: () => void;
};

const COLORS: string[] = [
  '#FF6B6B',
  '#4ECDC4',
  '#FFD93D',
  '#6BCB77',
  '#A66CFF',
  '#FF9F68',
  '#3D8BFD',
  '#E83E8C',
];

/**
 * "Мой профиль" page — extracted from the old single-page Settings.
 * Holds the user-owned bits: name, color, away/sick mode, timezone.
 * Notification settings, language, family-wide actions stay in the
 * Settings (formerly "Profile") tab so this page stays focused.
 */
export function MyProfile({ me, family, onBack }: Props) {
  const queryClient = useQueryClient();
  const t = useT();
  const updateMe = useMutation({
    mutationFn: api.updateMe,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });
  const myMember = membersQuery.data?.members.find((m) => m.id === me.id);
  const isOwner = myMember?.role.name === 'Owner';

  const isAway = me.awayUntil != null && new Date(me.awayUntil) > new Date();
  const awayReason = (me.awayReason ?? null) as 'vacation' | 'sick' | null;
  const isVacation = isAway && (awayReason === null || awayReason === 'vacation');
  const isSick = isAway && awayReason === 'sick';
  const sevenDays = () => new Date(Date.now() + 7 * 86_400_000).toISOString();
  const threeDays = () => new Date(Date.now() + 3 * 86_400_000).toISOString();

  const [tzPickerOpen, setTzPickerOpen] = useState(false);

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
          {t.locale === 'en' ? 'My profile' : 'Мой профиль'}
        </span>
      </div>

      {/* Identity card */}
      <div className="wf-card" style={{ textAlign: 'center', padding: 14 }}>
        <Av
          m={{
            id: me.id,
            name: me.firstName,
            letter: me.firstName.slice(0, 1).toUpperCase(),
            color: me.color,
            role: isOwner ? 'Owner' : 'Adult',
          }}
          size="xl"
        />
        <div className="wf-h3" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>
          {me.firstName}
          {me.lastName && ` ${me.lastName}`}
        </div>
        <span className="wf-hint" style={{ overflowWrap: 'anywhere' }}>
          {me.username ? `@${me.username}` : t.locale === 'en' ? 'from TG' : 'из TG'}
        </span>
      </div>

      {/* Color */}
      <div className="wf-card">
        <span className="wf-tiny">{t('profile.color')}</span>
        <div className="wf-row wf-gap-6" style={{ flexWrap: 'wrap', marginTop: 6 }}>
          {COLORS.map((c) => {
            const sel = c.toLowerCase() === me.color.toLowerCase();
            return (
              <span
                key={c}
                className="wf-mc"
                onClick={() => updateMe.mutate({ color: c })}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 999,
                  background: c,
                  border: sel ? '2.5px solid var(--ink)' : '1.5px solid var(--line)',
                  cursor: 'pointer',
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Vacation */}
      <div className="wf-card">
        <div className="wf-spread">
          <div className="wf-row wf-gap-8">
            <span style={{ fontSize: 18 }}>🌴</span>
            <div className="wf-col">
              <span className="wf-label">{t('profile.away.title')}</span>
              <span className="wf-tiny">
                {isVacation
                  ? t('profile.away.until', { date: fmtDate(me.awayUntil!, t.locale) })
                  : t('profile.away.hint')}
              </span>
            </div>
          </div>
          <Toggle
            on={isVacation}
            onClick={() => {
              if (isVacation) {
                updateMe.mutate({ awayUntil: null, awayReason: null });
              } else {
                updateMe.mutate({ awayUntil: sevenDays(), awayReason: 'vacation' });
              }
            }}
          />
        </div>
      </div>

      {/* Sick */}
      <div className="wf-card">
        <div className="wf-spread">
          <div className="wf-row wf-gap-8">
            <span style={{ fontSize: 18 }}>🤒</span>
            <div className="wf-col">
              <span className="wf-label">
                {t.locale === 'en' ? 'Sick' : 'Болею'}
              </span>
              <span className="wf-tiny">
                {isSick
                  ? t('profile.away.until', { date: fmtDate(me.awayUntil!, t.locale) })
                  : t.locale === 'en'
                    ? 'queues will skip me'
                    : 'очереди будут пропускать меня'}
              </span>
            </div>
          </div>
          <Toggle
            on={isSick}
            onClick={() => {
              if (isSick) {
                updateMe.mutate({ awayUntil: null, awayReason: null });
              } else {
                updateMe.mutate({ awayUntil: threeDays(), awayReason: 'sick' });
              }
            }}
          />
        </div>
      </div>

      {/* Timezone */}
      <div
        className="wf-card compact"
        onClick={() => setTzPickerOpen(true)}
        style={{ cursor: 'pointer' }}
      >
        <div className="wf-spread">
          <div className="wf-row wf-gap-8">
            <Icon name="clock" />
            <span className="wf-label">{t('profile.timezone')}</span>
          </div>
          <div className="wf-row wf-gap-6">
            <span className="wf-hint">{me.timezone}</span>
            <Icon name="chevR" />
          </div>
        </div>
      </div>

      {tzPickerOpen && (
        <TimezonePicker
          current={me.timezone}
          onClose={() => setTzPickerOpen(false)}
          onPick={(tz) => {
            updateMe.mutate({ timezone: tz });
            setTzPickerOpen(false);
          }}
        />
      )}
    </WfBody>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <span
      onClick={onClick}
      style={{
        width: 36,
        height: 20,
        borderRadius: 999,
        background: on ? 'var(--ink)' : 'var(--softline)',
        position: 'relative',
        border: '1.5px solid var(--line)',
        flex: 'none',
        cursor: 'pointer',
        transition: 'background 0.15s',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: on ? 16 : 2,
          top: '50%',
          width: 14,
          height: 14,
          borderRadius: 999,
          background: 'var(--paper)',
          transform: 'translateY(-50%)',
          transition: 'left .15s',
        }}
      />
    </span>
  );
}

/**
 * Mirror of the Settings page's timezone picker — duplicated rather than
 * shared because both pages mount their own copy and the picker is small.
 */
function TimezonePicker({
  current,
  onClose,
  onPick,
}: {
  current: string;
  onClose: () => void;
  onPick: (tz: string) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const zones = useMemo(() => {
    const out: string[] = [];
    if (typeof Intl.supportedValuesOf === 'function') {
      try {
        out.push(...Intl.supportedValuesOf('timeZone'));
      } catch {
        /* fall through to curated list */
      }
    }
    if (out.length === 0) {
      out.push(
        'UTC',
        'Europe/London',
        'Europe/Paris',
        'Europe/Berlin',
        'Europe/Moscow',
        'Europe/Kiev',
        'Asia/Yerevan',
        'Asia/Tashkent',
        'Asia/Almaty',
        'Asia/Tokyo',
        'America/New_York',
        'America/Los_Angeles',
      );
    }
    return out;
  }, []);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return zones;
    return zones.filter((z) => z.toLowerCase().includes(q));
  }, [query, zones]);

  return (
    <BottomSheet onClose={onClose} zIndex={12}>
      {({ close }) => (
        <>
          <div className="handle" />
          <div className="wf-row wf-gap-8" style={{ marginBottom: 8 }}>
            <span className="wf-h2" style={{ flex: 1 }}>
              {t('profile.timezone')}
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
          <div className="wf-box" style={{ padding: '8px 10px', marginBottom: 8 }}>
            <div className="wf-row wf-gap-6">
              <Icon name="search" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('common.search.placeholder')}
                autoFocus
                className="wf-label"
                style={{
                  flex: 1,
                  border: 'none',
                  background: 'transparent',
                  outline: 'none',
                  color: 'var(--ink)',
                  font: 'inherit',
                }}
              />
            </div>
          </div>
          <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
            {filtered.length === 0 && (
              <span className="wf-hint" style={{ display: 'block', padding: 10 }}>
                {t('common.notFound')}
              </span>
            )}
            {filtered.map((tz) => {
              const isCurrent = tz === current;
              return (
                <div
                  key={tz}
                  className="wf-card compact"
                  onClick={() => close(() => onPick(tz))}
                  style={{ cursor: 'pointer', marginBottom: 4 }}
                >
                  <div className="wf-spread">
                    <span className="wf-label">{tz}</span>
                    {isCurrent && (
                      <span style={{ color: 'var(--success)' }}>
                        <Icon name="check" />
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </BottomSheet>
  );
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
