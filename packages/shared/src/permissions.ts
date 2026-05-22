export const PERMISSIONS = [
  'task.create',
  'task.edit.own',
  'task.edit.any',
  'task.delete.own',
  'task.delete.any',
  'task.complete.any',
  'catalog.manage',
  'template.manage',
  'reward.manage',
  'reward.grant',
  'reward.claim',
  'stats.view.others',
  'member.invite',
  'member.kick',
  'role.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const SYSTEM_ROLES = ['owner', 'adult', 'child'] as const;
export type SystemRoleName = (typeof SYSTEM_ROLES)[number];

export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRoleName, Permission[]> = {
  owner: [...PERMISSIONS],
  adult: [
    'task.create',
    'task.edit.own',
    'task.edit.any',
    'task.delete.own',
    'task.delete.any',
    'task.complete.any',
    'catalog.manage',
    'template.manage',
    'reward.manage',
    'reward.grant',
    'reward.claim',
    'stats.view.others',
    'member.invite',
  ],
  child: [
    'task.create',
    'task.edit.own',
    'task.delete.own',
    'reward.claim',
  ],
};
