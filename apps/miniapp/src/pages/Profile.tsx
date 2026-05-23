import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
} from '../api';
import { Av, Icon, Tag, WfBody, type Member } from '../design';
import { BottomSheet } from '../components/BottomSheet';
import { CopyButton } from '../components/CopyButton';
import { PageHeader } from '../components/PageHeader';
import { SettingsSheet } from '../components/SettingsPickers';
import { useT, type Locale, type TFn } from '../i18n';

type T = TFn;

type Props = {
  me: MeResponse;
  family: FamilySummary;
  families: FamilySummary[];
  onSwitchFamily: (id: string) => void;
  onLeft: () => void;
  onOpenMyProfile?: () => void;
  onOpenMember?: (userId: string) => void;
  /** Burger button → opens the nav drawer. Top-level page only. */
  onOpenDrawer?: () => void;
  /** Back button (shown instead of the burger when the user reached this
   *  page via in-app navigation rather than via the drawer). */
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
  onOpenMyProfile,
  onOpenMember,
  onOpenDrawer,
  onBack,
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

  const t = useT();

  return (
    <WfBody scrollKey="profile">
      <PageHeader title={t('nav.profile')} onBack={onBack} onOpenDrawer={onOpenDrawer} />

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
          const goTo = () => {
            if (isSelf) onOpenMyProfile?.();
            else onOpenMember?.(m.id);
          };
          const navigable = isSelf ? !!onOpenMyProfile : !!onOpenMember;
          return (
            <div
              key={m.id}
              className="wf-row wf-gap-10"
              onClick={navigable ? goTo : undefined}
              style={{
                padding: '10px 12px',
                cursor: navigable ? 'pointer' : 'default',
                borderBottom:
                  i < members.length - 1 ? '1px dashed var(--softline)' : 'none',
              }}
            >
              <Av m={m} size="md" />
              {/* Member info cell: name + role. `minWidth: 0` lets the
                  ellipsis kick in on long usernames; without it flex
                  children default to min-content and overflow the row. */}
              <div className="wf-col" style={{ flex: 1, minWidth: 0 }}>
                <span
                  className="wf-label"
                  style={{
                    display: 'block',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={m.name}
                >
                  {m.name}
                  {isSelf && (
                    <span className="wf-hint"> · {t.locale === 'en' ? 'you' : 'ты'}</span>
                  )}
                </span>
                <span className="wf-tiny">{roleLabel(m.role, t.locale)}</span>
              </div>
              {m.role === 'Owner' && <Tag>Owner</Tag>}
              {m.awayUntil && new Date(m.awayUntil) > new Date() && (
                <Tag variant="warn">{m.awayReason === 'sick' ? '🤒' : '🌴'}</Tag>
              )}
              {canActOn && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMemberActionId(m.id);
                  }}
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

      {/* Personal settings (color, away/sick, timezone, notifications,
          language) all live on the dedicated "Мой профиль" page —
          reachable from the burger drawer. Settings is family-only. */}

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

      {/* The "Family management" rows that used to live here (Search /
          Inbox / Stats / History / Catalog / Templates / Roles) all moved
          into the burger drawer — duplicating them here just confused
          users and left two ways to reach the same screen. Settings now
          focuses on family identity, members, notifications, language,
          and the owner-only Danger zone below. */}

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
  const [showCode, setShowCode] = useState(false);

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
        <CopyButton
          value={inviteLink ?? family.inviteCode}
          label={t('profile.family.copy')}
          variant="block"
          style={{ flex: 1 }}
        />
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

// clipboard write moved to shared components/CopyButton.tsx
