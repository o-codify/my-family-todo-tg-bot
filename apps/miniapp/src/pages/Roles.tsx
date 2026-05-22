import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
  type RoleDto,
} from '../api';
import { Av, AvStack, Icon, Tag, WfBody, type Member } from '../design';
import { useT } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  onBack: () => void;
};

const PERMISSION_KEYS: Record<string, string> = {
  'task.create': 'roles.perm.task.create',
  'task.edit.own': 'roles.perm.task.edit.own',
  'task.edit.any': 'roles.perm.task.edit.any',
  'task.delete.own': 'roles.perm.task.delete.own',
  'task.delete.any': 'roles.perm.task.delete.any',
  'task.complete.any': 'roles.perm.task.complete.any',
  'catalog.manage': 'roles.perm.catalog.manage',
  'template.manage': 'roles.perm.template.manage',
  'reward.manage': 'roles.perm.reward.manage',
  'reward.grant': 'roles.perm.reward.grant',
  'reward.claim': 'roles.perm.reward.claim',
  'stats.view.others': 'roles.perm.stats.view.others',
  'member.invite': 'roles.perm.member.invite',
  'member.kick': 'roles.perm.member.kick',
  'role.manage': 'roles.perm.role.manage',
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

function roleEmoji(name: string): string {
  const n = name.toLowerCase();
  if (n === 'owner') return '👑';
  if (n === 'adult' || n.includes('взросл')) return '🧑';
  if (n === 'child' || n.includes('ребён') || n.includes('ребен') || n.includes('child')) return '🧒';
  return '⭐';
}

/** Roles editor — port of RolesV1+R2 (screens-roles-catalog.jsx). */
export function Roles({ me, family, onBack }: Props) {
  void me;
  const queryClient = useQueryClient();
  const t = useT();
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);

  const rolesQuery = useQuery({
    queryKey: ['roles', family.id],
    queryFn: () => api.listRoles(family.id),
  });
  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });
  const roles = rolesQuery.data?.roles ?? [];
  const members = useMemo(
    () => (membersQuery.data?.members ?? []).map(memberFromDto),
    [membersQuery.data],
  );
  const membersByRole = useMemo(() => {
    const map = new Map<string, Member[]>();
    const rawMembers = membersQuery.data?.members ?? [];
    for (const m of rawMembers) {
      const list = map.get(m.role.id) ?? [];
      list.push(memberFromDto(m));
      map.set(m.role.id, list);
    }
    return map;
  }, [membersQuery.data]);
  const totalPerms = Object.keys(PERMISSION_KEYS).length;

  const selected = roles.find((r) => r.id === selectedRoleId) ?? null;
  const selectedMembers = selected ? membersByRole.get(selected.id) ?? [] : [];
  void members;

  const updateMut = useMutation({
    mutationFn: ({ roleId, permissions }: { roleId: string; permissions: string[] }) =>
      api.updateRolePermissions(family.id, roleId, permissions),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['roles', family.id] }),
  });

  const togglePerm = (perm: string) => {
    if (!selected) return;
    const has = selected.permissions.includes(perm);
    const next = has ? selected.permissions.filter((p) => p !== perm) : [...selected.permissions, perm];
    updateMut.mutate({ roleId: selected.id, permissions: next });
  };

  if (selected) {
    const readOnly = selected.name.toLowerCase() === 'owner';
    return (
      <WfBody onBack={onBack}>
        <div className="wf-row wf-gap-8">
          <button
            onClick={() => setSelectedRoleId(null)}
            aria-label={t('common.back')}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--ink)' }}
          >
            <Icon name="chevL" />
          </button>
          <div className="wf-col" style={{ flex: 1 }}>
            <span className="wf-h2">
              {t('roles.role.label')} · {selected.name}
            </span>
            <span className="wf-hint">
              {selectedMembers.length === 0
                ? t('roles.members.none')
                : `${selectedMembers.length} ${pluralMembersI18n(selectedMembers.length, t.locale === 'en')}: ${selectedMembers.map((m) => m.name).join(', ')}`}
            </span>
          </div>
          {readOnly && <Tag>{t('roles.tag.readonly')}</Tag>}
        </div>
        <div className="wf-card subtle">
          <span className="wf-tiny">
            {readOnly ? t('roles.readOnly') : t('roles.realtime')}
          </span>
        </div>
        <div className="wf-card" style={{ padding: 0 }}>
          {Object.keys(PERMISSION_KEYS).map((perm, i, arr) => {
            const checked = selected.permissions.includes(perm);
            return (
              <div
                key={perm}
                onClick={() => !readOnly && togglePerm(perm)}
                style={{
                  padding: '10px 12px',
                  borderBottom:
                    i < arr.length - 1 ? '1px dashed var(--softline)' : 'none',
                  cursor: readOnly ? 'not-allowed' : 'pointer',
                  opacity: readOnly ? 0.7 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span
                  className="wf-label"
                  style={{ color: checked ? 'var(--ink)' : 'var(--hint)' }}
                >
                  {t(PERMISSION_KEYS[perm]!)}
                </span>
                <Toggle on={checked} />
              </div>
            );
          })}
        </div>
        {updateMut.error && (
          <div className="wf-card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>
            {t('roles.save.error')}
          </div>
        )}
      </WfBody>
    );
  }

  return (
    <WfBody onBack={onBack}>
      <div className="wf-row wf-gap-8">
        <button
          onClick={onBack}
          aria-label="Назад"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--ink)' }}
        >
          <Icon name="chevL" />
        </button>
        <span className="wf-h2" style={{ flex: 1 }}>
          {t('roles.title')}
        </span>
      </div>

      <span className="wf-hint">{t('roles.hint')}</span>

      {rolesQuery.isLoading && <span className="wf-hint">{t('common.loading')}</span>}

      {roles.map((r) => (
        <RoleCard
          key={r.id}
          role={r}
          totalPerms={totalPerms}
          members={membersByRole.get(r.id) ?? []}
          onClick={() => setSelectedRoleId(r.id)}
        />
      ))}
    </WfBody>
  );
}

function RoleCard({
  role,
  totalPerms,
  members,
  onClick,
}: {
  role: RoleDto;
  totalPerms: number;
  members: Member[];
  onClick: () => void;
}) {
  const t = useT();
  const isOwner = role.name.toLowerCase() === 'owner';
  const emoji = roleEmoji(role.name);
  return (
    <div className="wf-card" onClick={onClick} style={{ cursor: 'pointer' }}>
      <div className="wf-spread">
        <div className="wf-row wf-gap-10">
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: isOwner ? 'var(--ink)' : 'transparent',
              border: isOwner ? 'none' : '1.5px solid var(--line)',
              color: isOwner ? 'var(--paper)' : 'var(--ink)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
            }}
          >
            {emoji}
          </div>
          <div className="wf-col">
            <span className="wf-h3" style={{ textTransform: 'capitalize' }}>
              {role.name}
            </span>
            <span className="wf-tiny">
              {isOwner
                ? t('roles.allPerms')
                : t('roles.perms.fraction', { n: role.permissions.length, total: totalPerms })}
              {' · '}
              {members.length} {pluralMembersI18n(members.length, t.locale === 'en')}
            </span>
          </div>
        </div>
        {isOwner ? <Tag>{t('roles.tag.readonly')}</Tag> : <Icon name="chevR" />}
      </div>
      {members.length > 0 && (
        <div className="wf-row wf-gap-6" style={{ marginTop: 8 }}>
          <AvStack members={members} size="xs" />
          <span className="wf-tiny">{members.map((m) => m.name).join(', ')}</span>
        </div>
      )}
    </div>
  );
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span
      style={{
        width: 32,
        height: 18,
        borderRadius: 999,
        background: on ? 'var(--ink)' : 'var(--softline)',
        position: 'relative',
        display: 'inline-block',
        flex: 'none',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 16 : 2,
          width: 14,
          height: 14,
          borderRadius: 999,
          background: 'var(--paper)',
          transition: 'left 0.15s',
        }}
      />
    </span>
  );
}

function pluralMembersI18n(n: number, isEn: boolean): string {
  if (isEn) return n === 1 ? 'member' : 'members';
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'участник';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'участника';
  return 'участников';
}
