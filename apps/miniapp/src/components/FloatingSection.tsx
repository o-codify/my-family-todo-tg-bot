import { useMemo, useState } from 'react';
import type { OccurrenceDto, TaskDto } from '../api';
import { Icon, type Member } from '../design';
import { useT } from '../i18n';

/**
 * Collapsible "Когда-нибудь" rollup — lists floating tasks without a
 * scheduled date. Shared between Calendar (always at the bottom) and
 * Day (under the day's main list). Tasks on cooldown
 * (`pending.availableAt` in the future) are hidden because the backend
 * would reject completion anyway.
 */
export function FloatingSection({
  tasks,
  occurrences,
  memberById,
  onOpen,
  filterUserId,
}: {
  tasks: TaskDto[];
  occurrences: OccurrenceDto[];
  memberById: Map<string, Member>;
  onOpen: (occurrence: OccurrenceDto) => void;
  /** When set, only floating tasks assigned to this user are shown.
   *  `undefined` = no member filter active (the page is in "Все" mode),
   *  show everything. Tasks with `assigneeId === null` (unassigned —
   *  anyone in the family can grab them) are intentionally hidden under
   *  a per-member filter: they don't belong to that person yet. */
  filterUserId?: string | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const now = Date.now();
  const pendingByTask = useMemo(() => {
    const map = new Map<string, OccurrenceDto>();
    for (const o of occurrences) {
      if (o.status !== 'pending') continue;
      if (!map.has(o.taskId)) map.set(o.taskId, o);
    }
    return map;
  }, [occurrences]);
  const floating = tasks.filter((tk) => {
    if (tk.type !== 'floating' || tk.archivedAt) return false;
    const pending = pendingByTask.get(tk.id);
    if (pending?.availableAt && new Date(pending.availableAt).getTime() > now) {
      return false;
    }
    if (filterUserId != null && tk.assigneeId !== filterUserId) {
      return false;
    }
    return true;
  });
  if (floating.length === 0) return null;
  return (
    <>
      <div
        className="wf-spread wf-card subtle"
        style={{ marginTop: 2, cursor: 'pointer' }}
        onClick={() => setOpen(!open)}
      >
        <span className="wf-row wf-gap-6">
          <Icon name="list" />
          <span className="wf-label">{t('calendar.someday')}</span>
          <span className="wf-hint">· {floating.length}</span>
        </span>
        <Icon name={open ? 'chevD' : 'chevR'} />
      </div>
      {open &&
        floating.map((ft) => {
          const assignee = ft.assigneeId ? memberById.get(ft.assigneeId) ?? null : null;
          // Synth occurrence so TaskSheet can render the dateless row.
          const synthOcc: OccurrenceDto = {
            id: `floating:${ft.id}`,
            taskId: ft.id,
            scheduledDate: null,
            scheduledTime: null,
            assigneeId: ft.assigneeId,
            status: 'pending',
            subtasks: null,
            completedAt: null,
            completedBy: null,
            photoIds: null,
            pointsAwarded: 0,
            availableAt: null,
            approvedAt: null,
            approvedBy: null,
            rejectedAt: null,
            rejectedBy: null,
            rejectionReason: null,
            task: {
              id: ft.id,
              title: ft.title,
              type: ft.type,
              points: ft.points,
              photoRequired: ft.photoRequired,
              requiresApproval: ft.requiresApproval,
              isQuest: ft.isQuest,
              deadlineAt: ft.deadlineAt,
            },
          };
          return (
            <div
              key={ft.id}
              className="wf-card"
              onClick={() => onOpen(synthOcc)}
              style={{ cursor: 'pointer' }}
            >
              <div className="wf-row wf-gap-10">
                <span
                  className="wf-mc"
                  style={{
                    width: 4,
                    height: 28,
                    background: assignee?.color ?? 'var(--softline)',
                    borderRadius: 2,
                  }}
                />
                <div className="wf-col" style={{ flex: 1 }}>
                  <span className="wf-label">{ft.title}</span>
                  <span className="wf-hint">
                    {assignee?.name ?? t('day.unassigned')}
                    {ft.cooldownDays
                      ? ` · ${t('queues.detail.everyN', { n: ft.cooldownDays })}`
                      : ''}
                    {ft.points > 0 ? ` · +${ft.points}` : ''}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
    </>
  );
}
