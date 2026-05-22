import { getInitData } from './telegram';

/**
 * Pick the API base URL.
 *  1. Build-time `VITE_API_BASE_URL` when it doesn't point at localhost.
 *  2. Same host as the page on the API port — when the page is opened from a
 *     phone via the dev machine's LAN IP, localhost would resolve to the
 *     phone itself, so we mirror the current host.
 *  3. Fall back to localhost:3000.
 *
 * The base is normalized so users can write either form in the env var:
 *   - `https://example.com`
 *   - `https://example.com/api`         ← gets `/api` stripped
 *   - `https://example.com/api/v1`      ← gets `/api/v1` stripped
 * Every method in this file builds paths as `/api/v1/...` — duplicating
 * that prefix in the env was the easiest way to wind up with
 * `…/api/api/v1/me` in the URL.
 */
function normalizeBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api(\/v1)?$/, '');
}

function pickApiBaseUrl(): string {
  const envBase = normalizeBaseUrl(
    (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '',
  );
  const isLocalhostEnv = !envBase || /\/\/(localhost|127\.0\.0\.1)/.test(envBase);

  if (typeof window !== 'undefined') {
    const { hostname, protocol } = window.location;
    const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1';
    if (!isLocalHost && isLocalhostEnv) {
      let apiPort = '3000';
      if (envBase) {
        try {
          apiPort = new URL(envBase).port || '3000';
        } catch {
          // ignore malformed env, keep default 3000
        }
      }
      return `${protocol}//${hostname}:${apiPort}`;
    }
  }
  return envBase || 'http://localhost:3000';
}

const API_BASE_URL = pickApiBaseUrl();

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `tma ${getInitData()}`);
  // Only set Content-Type for JSON bodies. FormData uploads MUST be left
  // alone — the browser injects a `multipart/form-data; boundary=…` header
  // with the right boundary token, and overriding it would break parsing.
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? safeJson(text) : null;

  if (!res.ok) {
    throw new ApiError(`API ${res.status} ${path}`, res.status, body);
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type NotificationSettings = {
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  digestEnabled: boolean;
  digestTime: string;
  defaultReminderBeforeMinutes: number;
};

export type MeResponse = {
  id: string;
  telegramId: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  avatarUrl: string | null;
  color: string;
  locale: string;
  timezone: string;
  notificationSettings: NotificationSettings;
  awayUntil: string | null;
};

export type FamilySummary = {
  id: string;
  name: string;
  avatarUrl: string | null;
  ownerId: string;
  inviteCode: string;
  createdAt: string;
  myRole: { id: string; name: string; permissions: string[] };
};

export type FamilyMemberDto = {
  id: string;
  firstName: string;
  lastName: string | null;
  avatarUrl: string | null;
  color: string;
  awayUntil: string | null;
  joinedAt: string;
  role: { id: string; name: string; permissions: string[] };
};

export type TaskType = 'oneoff' | 'recurring' | 'floating' | 'queued';

export type OccurrenceDto = {
  id: string;
  taskId: string;
  scheduledDate: string | null;
  scheduledTime: string | null;
  assigneeId: string | null;
  status: 'pending' | 'done' | 'skipped' | 'expired';
  subtasks: Array<{ id: string; title: string; position: number; done: boolean }> | null;
  completedAt: string | null;
  completedBy: string | null;
  photoIds: string[] | null;
  pointsAwarded: number;
  availableAt: string | null;
  task: {
    id: string;
    title: string;
    type: TaskType;
    points: number;
    photoRequired: boolean;
    deadlineAt: string | null;
  };
};

export type TaskDto = {
  id: string;
  familyId: string;
  title: string;
  description: string | null;
  type: TaskType;
  schedule: unknown;
  assigneeId: string | null;
  queueUserIds: string[] | null;
  deadlineAt: string | null;
  points: number;
  photoRequired: boolean;
  singleShot: boolean;
  cooldownDays: number | null;
  subtasksTemplate: Array<{ id: string; title: string; position: number }> | null;
  createdBy: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateTaskPayload = {
  title: string;
  type: TaskType;
  schedule:
    | { kind: 'oneoff'; date: string; time?: string }
    | {
        kind: 'recurring';
        recurrence: 'daily' | 'weekly' | 'interval';
        daysOfWeek?: number[];
        intervalDays?: number;
        time?: string;
      }
    | { kind: 'floating' }
    | { kind: 'queued' };
  assigneeId?: string | null;
  /** Members who participate in a queued task's rotation. `null` (default)
   *  means "all family members". Ignored for non-queued task types. */
  queueUserIds?: string[] | null;
  points?: number;
  photoRequired?: boolean;
};

export const api = {
  me: () => request<MeResponse>('/api/v1/me'),
  listFamilies: () => request<{ families: FamilySummary[] }>('/api/v1/families'),
  listMembers: (familyId: string) =>
    request<{ members: FamilyMemberDto[] }>(`/api/v1/families/${familyId}/members`),
  createFamily: (input: { name: string; avatarUrl?: string | null }) =>
    request<{ family: FamilySummary; myRole: FamilySummary['myRole'] }>('/api/v1/families', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  joinFamily: (code: string) =>
    request<{ family: FamilySummary; myRole: FamilySummary['myRole'] }>('/api/v1/families/join', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  peekFamily: (code: string) =>
    request<{
      family: { id: string; name: string; avatarUrl: string | null; createdAt: string; memberCount: number };
      owner: { id: string; firstName: string; color: string } | null;
      members: Array<{ id: string; firstName: string; color: string }>;
    }>(`/api/v1/families/peek/${encodeURIComponent(code)}`),

  updateMe: (patch: {
    color?: string;
    locale?: string;
    timezone?: string;
    awayUntil?: string | null;
    notificationSettings?: Partial<NotificationSettings>;
  }) =>
    request<MeResponse>('/api/v1/me', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  leaveFamily: (familyId: string) =>
    request<null>(`/api/v1/families/${familyId}/leave`, { method: 'POST' }),
  updateFamily: (
    familyId: string,
    patch: { name?: string; avatarUrl?: string | null },
  ) =>
    request<{ family: FamilySummary }>(`/api/v1/families/${familyId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteFamily: (familyId: string) =>
    request<null>(`/api/v1/families/${familyId}`, { method: 'DELETE' }),
  rotateInvite: (familyId: string) =>
    request<{ family: FamilySummary }>(
      `/api/v1/families/${familyId}/invite/rotate`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  kickMember: (familyId: string, userId: string) =>
    request<null>(`/api/v1/families/${familyId}/members/${userId}`, {
      method: 'DELETE',
    }),

  listTasks: (familyId: string) =>
    request<{ tasks: TaskDto[] }>(`/api/v1/families/${familyId}/tasks`),

  listOccurrences: (familyId: string, from: string, to: string) =>
    request<{ occurrences: OccurrenceDto[] }>(
      `/api/v1/families/${familyId}/occurrences?from=${from}&to=${to}`,
    ),
  getOccurrence: (familyId: string, occurrenceId: string) =>
    request<{ occurrence: OccurrenceDto }>(
      `/api/v1/families/${familyId}/occurrences/${occurrenceId}`,
    ),
  completeOccurrence: (familyId: string, occurrenceId: string) =>
    request<{ occurrence: OccurrenceDto }>(
      `/api/v1/families/${familyId}/occurrences/${occurrenceId}/complete`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  /**
   * Floating tasks don't have a pre-existing occurrence row — completing one
   * creates the occurrence on the fly. The Calendar synthesizes a fake
   * "floating:<taskId>" occurrence id for UI purposes; call this endpoint with
   * the *task* id (not the synth occurrence id) to actually mark it done.
   */
  completeFloatingTask: (familyId: string, taskId: string) =>
    request<{ occurrence: OccurrenceDto }>(
      `/api/v1/families/${familyId}/tasks/${taskId}/complete-floating`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  /**
   * Patch subtask done-state on a pending occurrence. Used when the user
   * checks off a subtask in TaskSheet without yet completing the parent.
   */
  updateSubtasksState: (
    familyId: string,
    occurrenceId: string,
    patch: Array<{ id: string; done: boolean }>,
  ) =>
    request<{ occurrence: OccurrenceDto }>(
      `/api/v1/families/${familyId}/occurrences/${occurrenceId}/subtasks`,
      { method: 'PATCH', body: JSON.stringify({ patch }) },
    ),
  uncompleteOccurrence: (familyId: string, occurrenceId: string) =>
    request<{ occurrence: OccurrenceDto }>(
      `/api/v1/families/${familyId}/occurrences/${occurrenceId}/uncomplete`,
      { method: 'POST' },
    ),
  /** Move a pending occurrence to another calendar date (YYYY-MM-DD). */
  rescheduleOccurrence: (
    familyId: string,
    occurrenceId: string,
    scheduledDate: string,
  ) =>
    request<{ occurrence: OccurrenceDto }>(
      `/api/v1/families/${familyId}/occurrences/${occurrenceId}/reschedule`,
      { method: 'POST', body: JSON.stringify({ scheduledDate }) },
    ),

  createTask: (familyId: string, payload: CreateTaskPayload) =>
    request<{ task: { id: string; title: string } }>(`/api/v1/families/${familyId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateTask: (familyId: string, taskId: string, payload: Partial<CreateTaskPayload>) =>
    request<{ task: TaskDto }>(`/api/v1/families/${familyId}/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteTask: (familyId: string, taskId: string) =>
    request<null>(`/api/v1/families/${familyId}/tasks/${taskId}`, { method: 'DELETE' }),

  listCatalog: (familyId: string, q?: string) =>
    request<{ items: CatalogItemDto[] }>(
      `/api/v1/families/${familyId}/catalog${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    ),
  createCatalogItem: (
    familyId: string,
    payload: { name: string; emoji?: string | null; category?: string | null },
  ) =>
    request<{ item: CatalogItemDto }>(`/api/v1/families/${familyId}/catalog`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateCatalogItem: (
    familyId: string,
    itemId: string,
    payload: { name?: string; emoji?: string | null; category?: string | null },
  ) =>
    request<{ item: CatalogItemDto }>(`/api/v1/families/${familyId}/catalog/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteCatalogItem: (familyId: string, itemId: string) =>
    request<null>(`/api/v1/families/${familyId}/catalog/${itemId}`, { method: 'DELETE' }),

  listTemplates: (familyId: string) =>
    request<{ templates: TemplateDto[] }>(`/api/v1/families/${familyId}/templates`),
  createTemplate: (
    familyId: string,
    payload: { name: string; emoji?: string | null; payload: TaskTemplatePayload },
  ) =>
    request<{ template: TemplateDto }>(`/api/v1/families/${familyId}/templates`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteTemplate: (familyId: string, templateId: string) =>
    request<null>(`/api/v1/families/${familyId}/templates/${templateId}`, { method: 'DELETE' }),

  listRewards: (familyId: string) =>
    request<{ rewards: RewardDto[] }>(`/api/v1/families/${familyId}/rewards`),
  createReward: (
    familyId: string,
    payload: {
      name: string;
      emoji?: string | null;
      description?: string | null;
      costPoints: number;
    },
  ) =>
    request<{ reward: RewardDto }>(`/api/v1/families/${familyId}/rewards`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteReward: (familyId: string, rewardId: string) =>
    request<null>(`/api/v1/families/${familyId}/rewards/${rewardId}`, { method: 'DELETE' }),
  redeemReward: (familyId: string, rewardId: string) =>
    request<{ redemption: RedemptionDto }>(
      `/api/v1/families/${familyId}/rewards/${rewardId}/redeem`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  listRedemptions: (familyId: string, status?: 'pending' | 'granted' | 'rejected') =>
    request<{ redemptions: RedemptionDto[] }>(
      `/api/v1/families/${familyId}/rewards/redemptions${status ? `?status=${status}` : ''}`,
    ),
  grantRedemption: (familyId: string, redId: string) =>
    request<null>(`/api/v1/families/${familyId}/rewards/redemptions/${redId}/grant`, {
      method: 'POST',
    }),
  rejectRedemption: (familyId: string, redId: string) =>
    request<null>(`/api/v1/families/${familyId}/rewards/redemptions/${redId}/reject`, {
      method: 'POST',
    }),
  myBalance: (familyId: string) =>
    request<{ points: number }>(`/api/v1/families/${familyId}/rewards/balance/me`),

  listIncomingTransfers: (familyId: string) =>
    request<{ transfers: TransferDto[] }>(
      `/api/v1/families/${familyId}/transfers/incoming`,
    ),
  createTransfer: (
    familyId: string,
    payload: {
      occurrenceId: string;
      toUserId: string;
      mode?: 'plain' | 'swap' | 'reward';
      message?: string | null;
    },
  ) =>
    request<{ transfer: TransferDto }>(`/api/v1/families/${familyId}/transfers`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  acceptTransfer: (familyId: string, transferId: string) =>
    request<null>(`/api/v1/families/${familyId}/transfers/${transferId}/accept`, {
      method: 'POST',
    }),
  rejectTransfer: (familyId: string, transferId: string) =>
    request<null>(`/api/v1/families/${familyId}/transfers/${transferId}/reject`, {
      method: 'POST',
    }),

  // ─── Photos (Telegram-native storage) ────────────────────────────
  //
  // Upload is multipart/form-data; backend re-uploads the file to the user's
  // private chat with the bot and keeps only file_id + message_id in the DB.
  // We never store binary blobs ourselves.
  uploadPhoto: (familyId: string, occurrenceId: string, file: File) => {
    const form = new FormData();
    form.append('file', file, file.name || 'photo.jpg');
    return request<{ photo: PhotoDto }>(
      `/api/v1/families/${familyId}/occurrences/${occurrenceId}/photos`,
      // NOTE: do NOT set Content-Type — the browser fills the multipart
      // boundary header automatically.
      { method: 'POST', body: form },
    );
  },
  listPhotosByTask: (familyId: string, taskId: string) =>
    request<{ photos: PhotoDto[] }>(
      `/api/v1/families/${familyId}/tasks/${taskId}/photos`,
    ),
  listPhotosByOccurrence: (familyId: string, occurrenceId: string) =>
    request<{ photos: PhotoDto[] }>(
      `/api/v1/families/${familyId}/occurrences/${occurrenceId}/photos`,
    ),
  /** Returns a short-lived Telegram CDN URL for the photo. */
  getPhotoUrl: (familyId: string, photoId: string) =>
    request<{ url: string; ttlSeconds: number }>(
      `/api/v1/families/${familyId}/photos/${photoId}/url`,
    ),
  deletePhoto: (familyId: string, photoId: string) =>
    request<null>(`/api/v1/families/${familyId}/photos/${photoId}`, {
      method: 'DELETE',
    }),

  listRoles: (familyId: string) =>
    request<{ roles: RoleDto[] }>(`/api/v1/families/${familyId}/roles`),
  updateRolePermissions: (familyId: string, roleId: string, permissions: string[]) =>
    request<{ role: RoleDto }>(`/api/v1/families/${familyId}/roles/${roleId}`, {
      method: 'PATCH',
      body: JSON.stringify({ permissions }),
    }),
  assignMemberRole: (familyId: string, userId: string, roleId: string) =>
    request<null>(`/api/v1/families/${familyId}/roles/assign`, {
      method: 'POST',
      body: JSON.stringify({ userId, roleId }),
    }),

  /**
   * Server-aggregated stats. Replaces the old client-side computation that
   * pulled every occurrence + every task in the period. See the backend
   * `services/stats.ts` for the shape.
   */
  getStats: (familyId: string, period: 'week' | 'month' | 'all') =>
    request<StatsDto>(`/api/v1/families/${familyId}/stats?period=${period}`),
};

export type StatsDto = {
  period: { kind: 'week' | 'month' | 'all'; from: string; to: string };
  total: number;
  byMember: Array<{ userId: string; count: number; pointsEarned: number }>;
  topTasks: Array<{ taskId: string; title: string; count: number }>;
  streaks: {
    me: { current: number; longest: number };
    familyBest: { userId: string | null; days: number };
  };
  unfairness: {
    ratio: number;
    topUserId: string | null;
    bottomUserId: string | null;
  };
};

export type RoleDto = {
  id: string;
  familyId: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
  createdAt: string;
};

export type TransferDto = {
  id: string;
  familyId: string;
  occurrenceId: string;
  fromUserId: string;
  toUserId: string;
  mode: 'plain' | 'swap' | 'reward';
  message: string | null;
  swapOccurrenceIds: string[] | null;
  rewards: unknown[] | null;
  status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'cancelled';
  expiresAt: string;
  resolvedAt: string | null;
  createdAt: string;
};

export type RewardDto = {
  id: string;
  familyId: string;
  name: string;
  emoji: string | null;
  description: string | null;
  costPoints: number;
  availableForUserIds: string[] | null;
  archivedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type RedemptionDto = {
  id: string;
  rewardId: string | null;
  userId: string;
  familyId: string;
  costPoints: number;
  status: 'pending' | 'granted' | 'rejected';
  requestedAt: string;
  grantedAt: string | null;
  grantedBy: string | null;
};

export type TaskTemplatePayload = {
  title: string;
  type: TaskType;
  schedule: CreateTaskPayload['schedule'];
  points?: number;
  photoRequired?: boolean;
  subtasks?: Array<{ title: string }>;
};

export type TemplateDto = {
  id: string;
  familyId: string | null;
  name: string;
  emoji: string | null;
  payload: TaskTemplatePayload;
  isSystem: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PhotoDto = {
  id: string;
  taskId: string;
  occurrenceId: string | null;
  userId: string;
  createdAt: string;
};

export type CatalogItemDto = {
  id: string;
  familyId: string;
  name: string;
  emoji: string | null;
  category: string | null;
  lastPriceCents: number | null;
  lastCurrency: string | null;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
