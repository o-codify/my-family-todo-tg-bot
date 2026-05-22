import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
  type NotificationSettings,
} from '../api';
import { Av, Icon, Tag, WfBody, type Member } from '../design';
import { BottomSheet } from '../components/BottomSheet';
import { makeT, normalizeLocale, useT, type Locale, type TFn } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  families: FamilySummary[];
  onSwitchFamily: (id: string) => void;
  onLeft: () => void;
  onOpenStats?: () => void;
  onOpenHistory?: () => void;
  onOpenCatalog?: () => void;
  onOpenTemplates?: () => void;
  onOpenRoles?: () => void;
  onOpenSearch?: () => void;
  onOpenInbox?: () => void;
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
 * Combines FamV1 (family info + members + invite) and UsrV1 (my profile:
 * color, away mode, timezone) on a single tab. This is the place the user
 * returns to in order to share the invite again, change settings, or leave.
 */
export function Profile({
  me,
  family,
  families,
  onSwitchFamily,
  onLeft,
  onOpenStats,
  onOpenHistory,
  onOpenCatalog,
  onOpenTemplates,
  onOpenRoles,
  onOpenSearch,
  onOpenInbox,
}: Props) {
  const queryClient = useQueryClient();
  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });
  const members = useMemo(
    () => (membersQuery.data?.members ?? []).map(memberFromDto),
    [membersQuery.data],
  );

  const updateMe = useMutation({
    mutationFn: api.updateMe,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  const leave = useMutation({
    mutationFn: () => api.leaveFamily(family.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['families'] });
      onLeft();
    },
  });

  // Owner-only family-wide mutations. We invalidate `families` on success
  // (App.tsx re-reads to refresh the active family / nav back to onboarding
  // after delete).
  const renameFamily = useMutation({
    mutationFn: (name: string) => api.updateFamily(family.id, { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['families'] }),
  });
  const rotateInvite = useMutation({
    mutationFn: () => api.rotateInvite(family.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['families'] }),
  });
  const deleteFamily = useMutation({
    mutationFn: () => api.deleteFamily(family.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['families'] });
      onLeft();
    },
  });
  // Per-member mutations. Affects `members` query so the row disappears
  // (kick) or the role label flips (assign).
  const kickMember = useMutation({
    mutationFn: (userId: string) => api.kickMember(family.id, userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['members', family.id] }),
  });
  const assignRole = useMutation({
    mutationFn: (input: { userId: string; roleId: string }) =>
      api.assignMemberRole(family.id, input.userId, input.roleId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['members', family.id] }),
  });
  const rolesQuery = useQuery({
    queryKey: ['roles', family.id],
    queryFn: () => api.listRoles(family.id),
  });

  const isAway = me.awayUntil != null && new Date(me.awayUntil) > new Date();
  const myMemberDto = membersQuery.data?.members.find((m) => m.id === me.id);
  // "Owner" in our model is `family.ownerId`, not the role label — but the
  // first owner gets the Owner role at creation. Use the role to gate the
  // owner-only UI bits and let the backend do the strict ownership check.
  const isFamilyOwner = myMemberDto?.role.name === 'Owner';
  const isOwner = isFamilyOwner;
  const perms = myMemberDto?.role.permissions ?? [];
  const canKick = perms.includes('member.kick');
  const canManageRoles = perms.includes('role.manage');
  const canRotateInvite = perms.includes('member.invite');

  const [memberActionId, setMemberActionId] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);

  const [tzPickerOpen, setTzPickerOpen] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);
  const [quietOpen, setQuietOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);

  const t = useT();
  const notif = me.notificationSettings;
  void makeT; // re-exported above for the sub-pickers' isolated locale contexts
  const localeLabel = normalizeLocale(me.locale) === 'en' ? 'English' : 'Русский';
  const digestValue = notif.digestEnabled ? notif.digestTime : t('profile.notifications.quietHours.off');
  const reminderValue = `${notif.defaultReminderBeforeMinutes} ${t('profile.notifications.reminder.value')}`;
  const quietValue =
    notif.quietHoursStart && notif.quietHoursEnd
      ? `${notif.quietHoursStart} – ${notif.quietHoursEnd}`
      : t('profile.notifications.quietHours.off');

  return (
    <WfBody>
      {/* Family selector (if multiple) */}
      {families.length > 1 && (
        <select
          value={family.id}
          onChange={(e) => onSwitchFamily(e.target.value)}
          className="wf-h2"
          style={{
            border: 'none',
            background: 'transparent',
            padding: 0,
            color: 'var(--ink)',
            fontFamily: 'inherit',
          }}
        >
          {families.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      )}

      {/* ── Family header (FamV1 lines 14-22) ── */}
      <div className="wf-card" style={{ textAlign: 'center', padding: 14 }}>
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 16,
            background: 'var(--faint)',
            border: '1.5px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 28,
            margin: '0 auto 6px',
          }}
        >
          {family.avatarUrl ?? '🏠'}
        </div>
        <span className="wf-h3">{family.name}</span>
        <div className="wf-hint">
          {members.length} {pluralPeople(members.length, t.locale)}
          {t.locale === 'en' ? ' · since ' : ' · с '}
          {fmtDate(family.createdAt, t.locale)}
        </div>
      </div>

      {/* ── Invite share (FamV1 lines 45-56) ── */}
      <InviteCard family={family} />

      {/* One-member edge (FamV2 banner) */}
      {members.length === 1 && <OneMemberBanner />}

      {/* ── Members list (FamV1 lines 25-42) ── */}
      <div className="wf-spread">
        <span className="wf-h3">
          {t.locale === 'en' ? 'Members' : 'Участники'}
        </span>
        <span className="wf-tiny">{members.length}</span>
      </div>
      <div className="wf-card" style={{ padding: 0 }}>
        {members.map((m, i) => {
          // The "..." menu is shown for other members when the current user
          // has at least one applicable permission. We don't gate by role —
          // a Child with `member.invite` (impossibly configured) still gets
          // the menu so they can rotate invites.
          const isSelf = m.id === me.id;
          const canActOn = !isSelf && m.role !== 'Owner' && (canKick || canManageRoles);
          return (
            <div
              key={m.id}
              className="wf-row wf-gap-10"
              style={{
                padding: '10px 12px',
                borderBottom:
                  i < members.length - 1 ? '1px dashed var(--softline)' : 'none',
              }}
            >
              <Av m={m} size="md" />
              <div className="wf-col" style={{ flex: 1 }}>
                <span className="wf-label">
                  {m.name}
                  {isSelf && (
                    <span className="wf-hint"> · {t.locale === 'en' ? 'you' : 'ты'}</span>
                  )}
                </span>
                <span className="wf-tiny">{roleLabel(m.role, t.locale)}</span>
              </div>
              {m.role === 'Owner' && <Tag>Owner</Tag>}
              {m.awayUntil && new Date(m.awayUntil) > new Date() && (
                <Tag variant="warn">🌴</Tag>
              )}
              {canActOn && (
                <button
                  type="button"
                  onClick={() => setMemberActionId(m.id)}
                  aria-label={t.locale === 'en' ? 'Actions' : 'Действия'}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    color: 'var(--hint)',
                    flex: 'none',
                  }}
                >
                  <Icon name="more" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* ── My profile section (UsrV1) ─────────── */}
      <span className="wf-h3" style={{ marginTop: 4 }}>
        {t.locale === 'en' ? 'My profile' : 'Мой профиль'}
      </span>

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
        <div className="wf-h3" style={{ marginTop: 6 }}>
          {me.firstName}
          {me.lastName && ` ${me.lastName}`}
        </div>
        <span className="wf-hint">
          {me.username ? `@${me.username}` : t.locale === 'en' ? 'from TG' : 'из TG'}
        </span>
      </div>

      {/* Color picker — UsrV1 lines 132-143 */}
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

      {/* Away mode toggle — UsrV1 lines 149-160 */}
      <div className="wf-card">
        <div className="wf-spread">
          <div className="wf-row wf-gap-8">
            <span style={{ fontSize: 18 }}>🌴</span>
            <div className="wf-col">
              <span className="wf-label">{t('profile.away.title')}</span>
              <span className="wf-tiny">
                {isAway
                  ? t('profile.away.until', { date: fmtDate(me.awayUntil!, t.locale) })
                  : t('profile.away.hint')}
              </span>
            </div>
          </div>
          <Toggle
            on={isAway}
            onClick={() => {
              if (isAway) updateMe.mutate({ awayUntil: null });
              else {
                // Default: away for next 7 days
                const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
                updateMe.mutate({ awayUntil: until });
              }
            }}
          />
        </div>
      </div>

      {/* Timezone — opens a sheet to pick an IANA zone. */}
      <ListRow
        icon="clock"
        label={t('profile.timezone')}
        value={me.timezone}
        onClick={() => setTzPickerOpen(true)}
      />
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

      {/* Notifications — wired to user.notificationSettings on the backend.
          Actual delivery (digest/reminder) is task #25 (BullMQ); for now we
          let users at least save their preferences. */}
      <span className="wf-h3" style={{ marginTop: 8 }}>
        {t('profile.notifications.title')}
      </span>
      <ListRow
        icon="bell"
        label={t('profile.notifications.digest')}
        value={digestValue}
        onClick={() => setDigestOpen(true)}
      />
      <ListRow
        icon="bell"
        label={t('profile.notifications.reminder')}
        value={reminderValue}
        onClick={() => setReminderOpen(true)}
      />
      <ListRow
        icon="bell"
        label={t('profile.notifications.quietHours')}
        value={quietValue}
        onClick={() => setQuietOpen(true)}
      />

      {/* Language */}
      <span className="wf-h3" style={{ marginTop: 8 }}>
        {t('profile.language.title')}
      </span>
      <ListRow
        icon="sett"
        label={t('profile.language.row')}
        value={localeLabel}
        onClick={() => setLangOpen(true)}
      />

      {digestOpen && (
        <DigestPicker
          t={t}
          settings={notif}
          onClose={() => setDigestOpen(false)}
          onSave={(patch) => {
            updateMe.mutate({ notificationSettings: patch });
            setDigestOpen(false);
          }}
        />
      )}
      {reminderOpen && (
        <ReminderPicker
          t={t}
          settings={notif}
          onClose={() => setReminderOpen(false)}
          onSave={(patch) => {
            updateMe.mutate({ notificationSettings: patch });
            setReminderOpen(false);
          }}
        />
      )}
      {quietOpen && (
        <QuietHoursPicker
          t={t}
          settings={notif}
          onClose={() => setQuietOpen(false)}
          onSave={(patch) => {
            updateMe.mutate({ notificationSettings: patch });
            setQuietOpen(false);
          }}
        />
      )}
      {langOpen && (
        <LanguagePicker
          t={t}
          current={normalizeLocale(me.locale)}
          onClose={() => setLangOpen(false)}
          onPick={(loc) => {
            updateMe.mutate({ locale: loc });
            setLangOpen(false);
          }}
        />
      )}

      {/* Per-member actions sheet (kick / change role). */}
      {memberActionId && (() => {
        const target = members.find((m) => m.id === memberActionId);
        if (!target) return null;
        return (
          <MemberActionsSheet
            t={t}
            target={target}
            roles={rolesQuery.data?.roles ?? []}
            canKick={canKick && target.role !== 'Owner'}
            canManageRoles={canManageRoles && target.role !== 'Owner'}
            onClose={() => setMemberActionId(null)}
            onKick={() => {
              if (
                window.confirm(
                  t('profile.member.confirmKick', { name: target.name }),
                )
              ) {
                kickMember.mutate(target.id);
                setMemberActionId(null);
              }
            }}
            onAssignRole={(roleId) => {
              assignRole.mutate({ userId: target.id, roleId });
              setMemberActionId(null);
            }}
          />
        );
      })()}

      {/* Rename family sheet (owner only). */}
      {renameOpen && (
        <RenameFamilySheet
          t={t}
          currentName={family.name}
          onClose={() => setRenameOpen(false)}
          onSave={(name) => {
            renameFamily.mutate(name);
            setRenameOpen(false);
          }}
        />
      )}

      {/* Family management nav */}
      <span className="wf-h3" style={{ marginTop: 8 }}>
        {t('profile.family.title')}
      </span>
      <ListRow icon="search" label={t('profile.section.search')} onClick={onOpenSearch} />
      <ListRow icon="bell" label={t('profile.section.inbox')} onClick={onOpenInbox} />
      <ListRow icon="chart" label={t('profile.section.stats')} onClick={onOpenStats} />
      <ListRow icon="clock" label={t('profile.section.history')} onClick={onOpenHistory} />
      <ListRow icon="pkg" label={t('profile.section.catalog')} onClick={onOpenCatalog} />
      <ListRow icon="list" label={t('profile.section.templates')} onClick={onOpenTemplates} />
      <ListRow icon="sett" label={t('profile.section.roles')} onClick={onOpenRoles} />

      {/* Owner-only Danger zone — rename + rotate + delete family. */}
      {isFamilyOwner && (
        <>
          <span className="wf-h3" style={{ marginTop: 8, color: 'var(--danger)' }}>
            {t.locale === 'en' ? 'Danger zone' : 'Опасная зона'}
          </span>
          <div className="wf-col wf-gap-6">
            <button
              type="button"
              className="wf-btn block"
              onClick={() => setRenameOpen(true)}
              style={{ cursor: 'pointer' }}
            >
              <Icon name="edit" />
              &nbsp;{t.locale === 'en' ? 'Rename family' : 'Переименовать семью'}
            </button>
            <button
              type="button"
              className="wf-btn block"
              onClick={() => {
                if (
                  window.confirm(
                    t.locale === 'en'
                      ? 'Rotate the invite code? The old code will stop working.'
                      : 'Сгенерировать новый инвайт-код? Старый перестанет работать.',
                  )
                ) {
                  rotateInvite.mutate();
                }
              }}
              disabled={rotateInvite.isPending}
              style={{ cursor: rotateInvite.isPending ? 'default' : 'pointer' }}
            >
              <Icon name="repeat" />
              &nbsp;{t.locale === 'en' ? 'Rotate invite code' : 'Обновить инвайт-код'}
            </button>
            <button
              type="button"
              className="wf-btn danger block"
              onClick={() => {
                if (
                  window.confirm(
                    t.locale === 'en'
                      ? 'Delete the family permanently? All tasks, history and rewards will be lost. This cannot be undone.'
                      : 'Удалить семью полностью? Все задачи, история и призы пропадут. Действие необратимо.',
                  )
                ) {
                  deleteFamily.mutate();
                }
              }}
              disabled={deleteFamily.isPending}
              style={{ cursor: deleteFamily.isPending ? 'default' : 'pointer' }}
            >
              <Icon name="trash" />
              &nbsp;{t.locale === 'en' ? 'Delete family' : 'Удалить семью'}
            </button>
          </div>
        </>
      )}

      {/* Non-owner: optional Rotate-invite button if the role grants it. */}
      {!isFamilyOwner && canRotateInvite && (
        <button
          type="button"
          className="wf-btn block"
          onClick={() => {
            if (
              window.confirm(
                t.locale === 'en'
                  ? 'Rotate the invite code?'
                  : 'Сгенерировать новый инвайт-код?',
              )
            ) {
              rotateInvite.mutate();
            }
          }}
          disabled={rotateInvite.isPending}
          style={{ marginTop: 4, cursor: rotateInvite.isPending ? 'default' : 'pointer' }}
        >
          <Icon name="repeat" />
          &nbsp;{t.locale === 'en' ? 'Rotate invite' : 'Новый инвайт-код'}
        </button>
      )}

      {/* Leave button */}
      <button
        className="wf-btn danger ghost block"
        onClick={() => {
          if (window.confirm(t('profile.leave.confirm'))) {
            leave.mutate();
          }
        }}
        disabled={isOwner || leave.isPending}
        style={{
          marginTop: 4,
          fontSize: 13,
          cursor: isOwner || leave.isPending ? 'not-allowed' : 'pointer',
          opacity: isOwner || leave.isPending ? 0.5 : 1,
        }}
        title={
          isOwner
            ? t.locale === 'en'
              ? 'Owner cannot leave the family'
              : 'Владелец не может покинуть семью'
            : undefined
        }
      >
        {isOwner
          ? t.locale === 'en'
            ? 'Owner cannot leave'
            : 'Владелец не может уйти'
          : t('profile.leave')}
      </button>
      {leave.error && (
        <div
          className="wf-card"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
        >
          {describeLeaveError(leave.error as ApiError, t.locale)}
        </div>
      )}
    </WfBody>
  );
}

function InviteCard({ family }: { family: FamilySummary }) {
  const t = useT();
  const botUsername = import.meta.env.VITE_TG_BOT_USERNAME as string | undefined;
  const inviteLink = botUsername
    ? `https://t.me/${botUsername}?start=${family.inviteCode}`
    : null;
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle');
  const [showCode, setShowCode] = useState(false);

  const handleCopy = async () => {
    const payload = inviteLink ?? family.inviteCode;
    const ok = await writeClipboard(payload);
    setCopyState(ok ? 'ok' : 'err');
    setTimeout(() => setCopyState('idle'), 2500);
  };

  const handleShare = () => {
    if (!inviteLink) return;
    const shareText =
      t.locale === 'en'
        ? `Join our family "${family.name}" in My Family Todo`
        : `Заходи в нашу семью «${family.name}» в My Family Todo`;
    const share = `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent(shareText)}`;
    window.open(share, '_blank');
  };

  return (
    <div className="wf-card elevated">
      <div className="wf-row wf-gap-10">
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: 'var(--ink)',
            color: 'var(--paper)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
          }}
        >
          <Icon name="invite" />
        </div>
        <div className="wf-col" style={{ flex: 1 }}>
          <span className="wf-label">
            {t.locale === 'en' ? 'Invite someone' : 'Пригласить нового'}
          </span>
          <span className="wf-tiny">
            {t.locale === 'en' ? 'code:' : 'код:'}{' '}
            <span
              className="wf-mono"
              style={{
                cursor: 'pointer',
                textDecoration: 'underline',
                textUnderlineOffset: 2,
              }}
              onClick={() => setShowCode(!showCode)}
            >
              {family.inviteCode}
            </span>
          </span>
        </div>
      </div>
      {showCode && (
        <div
          className="wf-box"
          style={{
            marginTop: 10,
            padding: '10px 12px',
            textAlign: 'center',
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            fontWeight: 700,
            fontSize: 22,
            letterSpacing: '0.16em',
          }}
        >
          {family.inviteCode}
        </div>
      )}
      <div className="wf-row wf-gap-8" style={{ marginTop: 10 }}>
        <button
          className="wf-btn block"
          onClick={handleCopy}
          style={{
            flex: 1,
            cursor: 'pointer',
            ...(copyState === 'ok'
              ? {
                  borderColor: 'var(--success)',
                  color: 'var(--success)',
                  background: 'rgba(74, 154, 90, 0.08)',
                }
              : copyState === 'err'
                ? { borderColor: 'var(--danger)', color: 'var(--danger)' }
                : null),
          }}
        >
          {copyState === 'ok'
            ? `✓ ${t('profile.family.copied')}`
            : copyState === 'err'
              ? t.locale === 'en'
                ? 'Failed'
                : 'Не получилось'
              : t('profile.family.copy')}
        </button>
        {inviteLink && (
          <button
            className="wf-btn primary block"
            onClick={handleShare}
            style={{ flex: 1, cursor: 'pointer' }}
          >
            {t('profile.family.share')}
          </button>
        )}
      </div>
    </div>
  );
}

function OneMemberBanner() {
  const t = useT();
  const isEn = t.locale === 'en';
  return (
    <div className="wf-card elevated" style={{ borderColor: 'var(--warn)' }}>
      <div className="wf-row wf-gap-10">
        <div style={{ fontSize: 28, flex: 'none' }}>👋</div>
        <div className="wf-col" style={{ flex: 1 }}>
          <span className="wf-label">
            {isEn ? 'Invite your family' : 'Пригласи близких'}
          </span>
          <span className="wf-tiny">
            {isEn
              ? 'queues, leaderboard and shop unlock once there are at least two of you'
              : 'очереди, лидер и магазин включатся, когда вас будет хотя бы двое'}
          </span>
        </div>
      </div>
    </div>
  );
}

function ListRow({
  icon,
  label,
  value,
  onClick,
}: {
  icon?: 'clock' | 'bell' | 'sett' | 'chart' | 'pkg' | 'list' | 'search';
  label: string;
  value?: string;
  onClick?: () => void;
}) {
  return (
    <div
      className="wf-card compact"
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      <div className="wf-spread">
        <div className="wf-row wf-gap-8">
          {icon && <Icon name={icon} />}
          <span className="wf-label">{label}</span>
        </div>
        <div className="wf-row wf-gap-6">
          {value && <span className="wf-hint">{value}</span>}
          <Icon name="chevR" />
        </div>
      </div>
    </div>
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

function roleLabel(role: string, locale: Locale = 'ru'): string {
  if (locale === 'en') {
    if (role === 'Owner') return 'owner';
    if (role === 'Adult') return 'adult';
    if (role === 'Child') return 'child';
    return role.toLowerCase();
  }
  if (role === 'Owner') return 'владелец';
  if (role === 'Adult') return 'взрослый';
  if (role === 'Child') return 'ребёнок';
  return role.toLowerCase();
}

type T = TFn;

/** Reusable scaffolding for the small "settings" bottom sheets below. */
function SettingsSheet({
  title,
  hint,
  onClose,
  children,
  footer,
}: {
  title: string;
  hint?: string;
  onClose: () => void;
  children: (api: { close: (after?: () => void) => void }) => React.ReactNode;
  footer?: (api: { close: (after?: () => void) => void }) => React.ReactNode;
}) {
  return (
    <BottomSheet onClose={onClose} zIndex={12}>
      {({ close }) => (
        <>
          <div className="handle" />
          <div className="wf-row wf-gap-8" style={{ marginBottom: 8 }}>
            <span className="wf-h2" style={{ flex: 1 }}>
              {title}
            </span>
            <button
              onClick={() => close()}
              aria-label="Close"
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
          {hint && (
            <span className="wf-hint" style={{ display: 'block', marginBottom: 8 }}>
              {hint}
            </span>
          )}
          {children({ close })}
          {footer && <div style={{ marginTop: 12 }}>{footer({ close })}</div>}
        </>
      )}
    </BottomSheet>
  );
}

/** "Утренний дайджест" — toggle + time grid (every 30 min from 06:00 to 12:00). */
function DigestPicker({
  t,
  settings,
  onClose,
  onSave,
}: {
  t: T;
  settings: NotificationSettings;
  onClose: () => void;
  onSave: (patch: Partial<NotificationSettings>) => void;
}) {
  const [enabled, setEnabled] = useState(settings.digestEnabled);
  const [time, setTime] = useState(settings.digestTime);
  const TIMES = ['06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '11:00', '12:00'];
  return (
    <SettingsSheet
      title={t('notif.digest.title')}
      hint={t('notif.digest.hint')}
      onClose={onClose}
      footer={({ close }) => (
        <div className="wf-row wf-gap-8">
          <button className="wf-btn" onClick={() => close()} style={{ cursor: 'pointer' }}>
            {t('common.cancel')}
          </button>
          <button
            className="wf-btn primary"
            style={{ flex: 1, cursor: 'pointer' }}
            onClick={() => close(() => onSave({ digestEnabled: enabled, digestTime: time }))}
          >
            {t('common.save')}
          </button>
        </div>
      )}
    >
      {() => (
        <>
          <div className="wf-card" style={{ marginBottom: 8 }}>
            <div className="wf-spread" onClick={() => setEnabled(!enabled)} style={{ cursor: 'pointer' }}>
              <span className="wf-label">{t('notif.digest.title')}</span>
              <MiniToggle on={enabled} />
            </div>
          </div>
          {enabled && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {TIMES.map((tt) => (
                <span
                  key={tt}
                  onClick={() => setTime(tt)}
                  className={'wf-tag' + (tt === time ? ' solid' : '')}
                  style={{ cursor: 'pointer', justifyContent: 'center' }}
                >
                  {tt}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </SettingsSheet>
  );
}

/** "Напоминание перед задачей" — minutes grid. */
function ReminderPicker({
  t,
  settings,
  onClose,
  onSave,
}: {
  t: T;
  settings: NotificationSettings;
  onClose: () => void;
  onSave: (patch: Partial<NotificationSettings>) => void;
}) {
  const OPTIONS = [0, 5, 10, 15, 30, 60, 120, 240];
  const [value, setValue] = useState(settings.defaultReminderBeforeMinutes);
  return (
    <SettingsSheet
      title={t('notif.reminder.title')}
      hint={t('notif.reminder.hint')}
      onClose={onClose}
      footer={({ close }) => (
        <div className="wf-row wf-gap-8">
          <button className="wf-btn" onClick={() => close()} style={{ cursor: 'pointer' }}>
            {t('common.cancel')}
          </button>
          <button
            className="wf-btn primary"
            style={{ flex: 1, cursor: 'pointer' }}
            onClick={() => close(() => onSave({ defaultReminderBeforeMinutes: value }))}
          >
            {t('common.save')}
          </button>
        </div>
      )}
    >
      {() => (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          {OPTIONS.map((m) => (
            <span
              key={m}
              onClick={() => setValue(m)}
              className={'wf-tag' + (m === value ? ' solid' : '')}
              style={{ cursor: 'pointer', justifyContent: 'center' }}
            >
              {m === 0 ? '—' : `${m} ${t('profile.notifications.reminder.value')}`}
            </span>
          ))}
        </div>
      )}
    </SettingsSheet>
  );
}

/** "Тихие часы" — start/end HH:MM inputs + enable toggle. */
function QuietHoursPicker({
  t,
  settings,
  onClose,
  onSave,
}: {
  t: T;
  settings: NotificationSettings;
  onClose: () => void;
  onSave: (patch: Partial<NotificationSettings>) => void;
}) {
  const [enabled, setEnabled] = useState(!!(settings.quietHoursStart && settings.quietHoursEnd));
  const [start, setStart] = useState(settings.quietHoursStart ?? '22:00');
  const [end, setEnd] = useState(settings.quietHoursEnd ?? '08:00');
  return (
    <SettingsSheet
      title={t('notif.quietHours.title')}
      hint={t('notif.quietHours.hint')}
      onClose={onClose}
      footer={({ close }) => (
        <div className="wf-row wf-gap-8">
          <button className="wf-btn" onClick={() => close()} style={{ cursor: 'pointer' }}>
            {t('common.cancel')}
          </button>
          <button
            className="wf-btn primary"
            style={{ flex: 1, cursor: 'pointer' }}
            onClick={() =>
              close(() =>
                onSave(
                  enabled
                    ? { quietHoursStart: start, quietHoursEnd: end }
                    : { quietHoursStart: null, quietHoursEnd: null },
                ),
              )
            }
          >
            {t('common.save')}
          </button>
        </div>
      )}
    >
      {() => (
        <>
          <div className="wf-card" style={{ marginBottom: 8 }}>
            <div
              className="wf-spread"
              onClick={() => setEnabled(!enabled)}
              style={{ cursor: 'pointer' }}
            >
              <span className="wf-label">{t('notif.quietHours.enable')}</span>
              <MiniToggle on={enabled} />
            </div>
          </div>
          {enabled && (
            <div className="wf-row wf-gap-8">
              <div className="wf-col wf-gap-2" style={{ flex: 1 }}>
                <span className="wf-tiny">{t('notif.quietHours.start')}</span>
                <div className="wf-box" style={{ padding: '8px 10px' }}>
                  <input
                    type="time"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
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
              <div className="wf-col wf-gap-2" style={{ flex: 1 }}>
                <span className="wf-tiny">{t('notif.quietHours.end')}</span>
                <div className="wf-box" style={{ padding: '8px 10px' }}>
                  <input
                    type="time"
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
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
          )}
        </>
      )}
    </SettingsSheet>
  );
}

/** Language picker — 2 options for now (RU/EN). Extend `Locale` to add more. */
function LanguagePicker({
  t,
  current,
  onClose,
  onPick,
}: {
  t: T;
  current: Locale;
  onClose: () => void;
  onPick: (loc: Locale) => void;
}) {
  const OPTIONS: { id: Locale; label: string; native: string }[] = [
    { id: 'ru', label: t('language.ru'), native: 'Русский' },
    { id: 'en', label: t('language.en'), native: 'English' },
  ];
  return (
    <SettingsSheet title={t('language.picker.title')} onClose={onClose}>
      {({ close }) =>
        OPTIONS.map((opt) => {
          const isCurrent = opt.id === current;
          return (
            <div
              key={opt.id}
              className="wf-card compact"
              onClick={() => close(() => onPick(opt.id))}
              style={{ cursor: 'pointer', marginBottom: 4 }}
            >
              <div className="wf-spread">
                <span className="wf-label">{opt.native}</span>
                {isCurrent && (
                  <span style={{ color: 'var(--success)' }}>
                    <Icon name="check" />
                  </span>
                )}
              </div>
            </div>
          );
        })
      }
    </SettingsSheet>
  );
}

function MiniToggle({ on }: { on: boolean }) {
  return (
    <span
      style={{
        width: 32,
        height: 18,
        background: on ? 'var(--ink)' : 'var(--softline)',
        borderRadius: 999,
        position: 'relative',
        flex: 'none',
        display: 'inline-block',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: on ? 16 : 2,
          top: 2,
          width: 14,
          height: 14,
          borderRadius: 999,
          background: 'var(--paper)',
          transition: 'left 0.15s ease',
        }}
      />
    </span>
  );
}

/** Bottom sheet that lets the user pick an IANA timezone. Falls back to a
 *  curated short list when the runtime doesn't expose Intl.supportedValuesOf. */
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
    // Intl.supportedValuesOf is ES2022, but older Telegram WebView runtimes
    // (esp. on iOS < 15) might not ship it. Runtime-check defensively and
    // fall through to the curated list below.
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
        'Europe/Minsk',
        'Asia/Yerevan',
        'Asia/Tbilisi',
        'Asia/Baku',
        'Asia/Tashkent',
        'Asia/Almaty',
        'Asia/Yekaterinburg',
        'Asia/Novosibirsk',
        'Asia/Krasnoyarsk',
        'Asia/Irkutsk',
        'Asia/Yakutsk',
        'Asia/Vladivostok',
        'Asia/Magadan',
        'Asia/Kamchatka',
        'America/New_York',
        'America/Chicago',
        'America/Los_Angeles',
        'Asia/Dubai',
        'Asia/Bangkok',
        'Asia/Tokyo',
        'Australia/Sydney',
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

function pluralPeople(n: number, locale: Locale = 'ru'): string {
  if (locale === 'en') return n === 1 ? 'person' : 'people';
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'человек';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'человека';
  return 'человек';
}

function describeLeaveError(err: ApiError, locale: Locale = 'ru'): string {
  const body = err.body as { error?: string } | null;
  if (body?.error === 'owner_must_transfer') {
    return locale === 'en'
      ? 'Owner cannot leave the family. Transfer ownership first.'
      : 'Владелец не может покинуть семью. Передайте права другому участнику.';
  }
  return err.message;
}

/**
 * Bottom sheet shown when the user taps the "..." on a member row. Offers
 * "Change role" (expands an inline role picker) and "Remove from family"
 * depending on what permissions the current user has. Owner-target is
 * filtered out by the caller — we never offer either action against the
 * family owner here.
 */
function MemberActionsSheet({
  t,
  target,
  roles,
  canKick,
  canManageRoles,
  onClose,
  onKick,
  onAssignRole,
}: {
  t: T;
  target: Member;
  roles: { id: string; name: string; isSystem: boolean }[];
  canKick: boolean;
  canManageRoles: boolean;
  onClose: () => void;
  onKick: () => void;
  onAssignRole: (roleId: string) => void;
}) {
  // Hide Owner from the role-picker — making someone Owner is *transfer of
  // ownership*, which is a different flow (not implemented yet).
  const assignableRoles = roles.filter((r) => r.name !== 'Owner');
  const [showRoles, setShowRoles] = useState(false);
  const isEn = t.locale === 'en';
  return (
    <SettingsSheet
      title={target.name}
      hint={isEn ? `Role: ${roleLabel(target.role, t.locale)}` : `Роль: ${roleLabel(target.role, t.locale)}`}
      onClose={onClose}
    >
      {({ close }) => (
        <>
          {canManageRoles && !showRoles && (
            <div
              className="wf-card compact"
              onClick={() => setShowRoles(true)}
              style={{ cursor: 'pointer', marginBottom: 4 }}
            >
              <div className="wf-spread">
                <div className="wf-row wf-gap-8">
                  <Icon name="sett" />
                  <span className="wf-label">
                    {isEn ? 'Change role' : 'Сменить роль'}
                  </span>
                </div>
                <Icon name="chevR" />
              </div>
            </div>
          )}
          {canManageRoles && showRoles && (
            <>
              <div className="wf-row wf-gap-8" style={{ marginBottom: 6 }}>
                <button
                  type="button"
                  onClick={() => setShowRoles(false)}
                  aria-label={isEn ? 'Back' : 'Назад'}
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
                <span className="wf-label">{isEn ? 'Pick a role' : 'Выбери роль'}</span>
              </div>
              {assignableRoles.map((r) => {
                const isCurrent = r.name === target.role;
                return (
                  <div
                    key={r.id}
                    className="wf-card compact"
                    onClick={() => close(() => onAssignRole(r.id))}
                    style={{ cursor: 'pointer', marginBottom: 4 }}
                  >
                    <div className="wf-spread">
                      <span className="wf-label">{roleLabel(r.name, t.locale)}</span>
                      {isCurrent && (
                        <span style={{ color: 'var(--success)' }}>
                          <Icon name="check" />
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
          {canKick && !showRoles && (
            <div
              className="wf-card compact"
              onClick={() => close(onKick)}
              style={{
                cursor: 'pointer',
                marginBottom: 4,
                borderColor: 'var(--danger)',
                color: 'var(--danger)',
              }}
            >
              <div className="wf-row wf-gap-8">
                <Icon name="trash" />
                <span className="wf-label" style={{ color: 'var(--danger)' }}>
                  {isEn ? 'Remove from family' : 'Удалить из семьи'}
                </span>
              </div>
            </div>
          )}
          {!canKick && !canManageRoles && (
            <span className="wf-hint" style={{ display: 'block', padding: 6 }}>
              {isEn ? 'No actions available.' : 'Нет доступных действий.'}
            </span>
          )}
        </>
      )}
    </SettingsSheet>
  );
}

/**
 * Tiny sheet with a single text input + Save/Cancel buttons. Used by the
 * owner-only "Rename family" action in the Danger zone.
 */
function RenameFamilySheet({
  t,
  currentName,
  onClose,
  onSave,
}: {
  t: T;
  currentName: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(currentName);
  const isEn = t.locale === 'en';
  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && trimmed.length <= 60 && trimmed !== currentName;
  return (
    <SettingsSheet
      title={isEn ? 'Rename family' : 'Переименовать семью'}
      onClose={onClose}
      footer={({ close }) => (
        <div className="wf-row wf-gap-8">
          <button className="wf-btn" onClick={() => close()} style={{ cursor: 'pointer' }}>
            {t('common.cancel')}
          </button>
          <button
            className="wf-btn primary"
            disabled={!canSave}
            onClick={() => canSave && close(() => onSave(trimmed))}
            style={{
              flex: 1,
              cursor: canSave ? 'pointer' : 'not-allowed',
              opacity: canSave ? 1 : 0.5,
            }}
          >
            {t('common.save')}
          </button>
        </div>
      )}
    >
      {() => (
        <div className="wf-box" style={{ padding: '8px 10px' }}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            autoFocus
            placeholder={isEn ? 'Family name' : 'Название семьи'}
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
      )}
    </SettingsSheet>
  );
}

async function writeClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
