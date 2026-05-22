import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  type CreateTaskPayload,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
  type TaskDto,
} from '../api';
import { Av, Icon, Seg, type Member } from '../design';
import { BottomSheet } from './BottomSheet';
import { useToast } from './Toast';
import { useT } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  defaultDate: string;
  onClose: () => void;
  onCreated: () => void;
  /** Pre-select task kind (e.g. "queued" when opened from Queues). */
  defaultKind?: TaskKind;
  /** When provided, the sheet enters edit mode (Сохранить + Удалить). */
  editingTask?: TaskDto;
};

type TaskKind = 'oneoff' | 'recurring' | 'floating' | 'queued';

// Day-of-week pills. Labels come from the dictionary at render time so they
// follow the active locale; ids match JS getDay() (0 = Sunday).
const DAY_IDS: number[] = [1, 2, 3, 4, 5, 6, 0];
const DAY_LABELS_RU = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const DAY_LABELS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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
 * Port of CreateV1 (screens-create.jsx lines 4-94) — wireframe variant A with
 * all fields: «Что сделать» + «Добавить в каталог», Type seg, per-type rows
 * («По дням недели» + «Кулдаун» for recurring, «Дата» for oneoff), 2-col rows
 * («Ответственный» + «Дедлайн», «Награда» + «Фото»), bottom «Шаблон» + Create.
 */
export function CreateTaskSheet({
  me,
  family,
  defaultDate,
  onClose,
  onCreated,
  defaultKind,
  editingTask,
}: Props) {
  const queryClient = useQueryClient();
  const t = useT();
  const isEn = t.locale === 'en';
  const KIND_LABELS: Record<TaskKind, string> = {
    oneoff: t('create.kind.oneoff'),
    recurring: t('create.kind.recurring'),
    floating: t('create.kind.floating'),
    queued: t('create.kind.queued'),
  };
  const KIND_BY_LABEL: Record<string, TaskKind> = {
    [KIND_LABELS.oneoff]: 'oneoff',
    [KIND_LABELS.recurring]: 'recurring',
    [KIND_LABELS.floating]: 'floating',
    [KIND_LABELS.queued]: 'queued',
  };
  const DAY_PILLS = DAY_IDS.map((id, i) => ({
    id,
    label: (isEn ? DAY_LABELS_EN : DAY_LABELS_RU)[i]!,
  }));
  const COOLDOWN_OPTIONS: Array<{ value: number | null; label: string }> = [
    { value: null, label: t('create.cooldown.off') },
    { value: 1, label: t('create.cooldown.day') },
    { value: 3, label: t('create.cooldown.3days') },
    { value: 7, label: t('create.cooldown.week') },
    { value: 14, label: t('create.cooldown.2weeks') },
    { value: 30, label: t('create.cooldown.month') },
  ];
  const initial = editingTask
    ? extractFromTask(editingTask)
    : {
        title: '',
        kind: (defaultKind ?? 'recurring') as TaskKind,
        date: defaultDate,
        daysOfWeek: [1, 2, 3, 4, 5],
        cooldownDays: null as number | null,
        points: 0,
        photoRequired: false,
        deadlineAt: null as string | null,
        assigneeId: me.id as string | null,
        queueUserIds: null as string[] | null,
        noDate: false,
        singleShot: false,
        subtasks: [] as string[],
        tagIds: [] as string[],
      };
  const [title, setTitle] = useState(initial.title);
  const [kind, setKind] = useState<TaskKind>(initial.kind);
  const [date, setDate] = useState(initial.date);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(initial.daysOfWeek);
  const [cooldownDays, setCooldownDays] = useState<number | null>(initial.cooldownDays);
  const [points, setPoints] = useState(initial.points);
  const [photoRequired, setPhotoRequired] = useState(initial.photoRequired);
  const [deadlineAt, setDeadlineAt] = useState<string | null>(initial.deadlineAt);
  const [assigneeId, setAssigneeId] = useState<string | null>(initial.assigneeId);
  // queueUserIds: explicit roster for `queued` tasks. `null` means "all
  // family members" (server default). Editing flips to an explicit list.
  const [queueUserIds, setQueueUserIds] = useState<string[] | null>(initial.queueUserIds);
  const [addToCatalog, setAddToCatalog] = useState(false);
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  // "Разовая без даты" — when set on a oneoff task, payload becomes
  // floating + singleShot (one-time fire-and-forget, picked from "Когда-нибудь").
  const [noDate, setNoDate] = useState(initial.noDate);
  // "Однократно" — for floating tasks, make them disappear after the first
  // completion instead of staying in "Когда-нибудь" forever.
  const [singleShot, setSingleShot] = useState(initial.singleShot);
  // Subtask titles (strings). We assign ids server-side. Edit mode loads
  // the existing template, plain-create starts empty. An empty trailing
  // input always exists so adding feels frictionless (Enter to commit).
  const [subtaskTitles, setSubtaskTitles] = useState<string[]>(initial.subtasks);
  // Tag attachments — multi-select chips. Tag list fetched lazily; users
  // can also create a new tag from inside the sheet (small "+" chip).
  const [tagIds, setTagIds] = useState<string[]>(initial.tagIds);

  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });
  const members = useMemo(
    () => (membersQuery.data?.members ?? []).map(memberFromDto),
    [membersQuery.data],
  );
  const assignee = members.find((m) => m.id === assigneeId);

  const mutation = useMutation({
    mutationFn: async () => {
      const payload = buildPayload({
        title: title.trim(),
        kind,
        date,
        daysOfWeek,
        cooldownDays,
        assigneeId,
        queueUserIds,
        points,
        photoRequired,
        deadlineAt,
        noDate,
        singleShot,
        subtasks: subtaskTitles
          .map((s) => s.trim())
          .filter(Boolean)
          .map((titleStr) => ({ title: titleStr })),
        tagIds,
      });
      if (editingTask) {
        return api.updateTask(family.id, editingTask.id, payload);
      }
      const created = await api.createTask(family.id, payload);
      // Side effects: optional catalog/template creation.
      if (addToCatalog) {
        try {
          await api.createCatalogItem(family.id, { name: title.trim() });
          queryClient.invalidateQueries({ queryKey: ['catalog', family.id] });
        } catch {
          // duplicate name etc. — ignore
        }
      }
      if (saveAsTemplate) {
        try {
          await api.createTemplate(family.id, {
            name: title.trim(),
            emoji: null,
            payload: {
              title: title.trim(),
              type: payload.type,
              schedule: payload.schedule,
              points: payload.points,
              photoRequired: payload.photoRequired,
            },
          });
          queryClient.invalidateQueries({ queryKey: ['templates', family.id] });
        } catch {
          // ignore
        }
      }
      return created;
    },
    // Success-side animated close is wired inside the BottomSheet render
    // (we need access to the `close()` helper from the render-prop scope).
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] });
      queryClient.invalidateQueries({ queryKey: ['tasks', family.id] });
    },
  });

  const toast = useToast();
  const deleteMut = useMutation({
    mutationFn: () => {
      if (!editingTask) throw new Error('not editing');
      return api.deleteTask(family.id, editingTask.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] });
      queryClient.invalidateQueries({ queryKey: ['tasks', family.id] });
      // Surface an undo toast — the backend keeps the task as soft-deleted
      // (archivedAt), so restore is just a POST. We capture `editingTask.id`
      // in the closure because by the time the user taps Undo this sheet
      // is already closed and `editingTask` may have been cleared.
      const taskId = editingTask?.id;
      if (taskId) {
        toast.show({
          message: t('common.deleted'),
          variant: 'success',
          durationMs: 5000,
          action: {
            label: t('common.undo'),
            onClick: () => {
              api
                .restoreTask(family.id, taskId)
                .then(() => {
                  queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] });
                  queryClient.invalidateQueries({ queryKey: ['tasks', family.id] });
                })
                .catch(() => {
                  toast.show({ message: t('common.restoreFailed'), variant: 'error' });
                });
            },
          },
        });
      }
    },
  });

  const canSubmit = title.trim().length > 0 && !mutation.isPending && !deleteMut.isPending;

  const cycleAssignee = () => {
    if (members.length === 0) {
      setAssigneeId(null);
      return;
    }
    const idx = assigneeId ? members.findIndex((m) => m.id === assigneeId) : -1;
    const next = idx === members.length - 1 ? null : members[idx + 1];
    setAssigneeId(next?.id ?? null);
  };

  return (
    <BottomSheet onClose={onClose} zIndex={10}>
      {({ close }) => {
        // After-mutation: animate close then run parent's onCreated callback.
        const finish = () => close(onCreated);
        return (
      <>
        <div className="handle" />

        {/* Header */}
        <div className="wf-spread" style={{ marginBottom: 8 }}>
          <span className="wf-h2">
            {editingTask ? t('create.title.edit') : t('create.title.new')}
          </span>
          <button
            onClick={() => close()}
            aria-label={t('common.close')}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--ink)' }}
          >
            <Icon name="x" />
          </button>
        </div>

        {/* Что сделать + Добавить в каталог */}
        <div className="wf-col wf-gap-4" style={{ marginBottom: 10 }}>
          <span className="wf-tiny">{t('create.field.title')}</span>
          <div className="wf-box" style={{ padding: '10px 12px' }}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('create.field.title.placeholder')}
              autoFocus
              className="wf-label"
              style={{
                width: '100%',
                border: 'none',
                background: 'transparent',
                outline: 'none',
                color: 'var(--ink)',
                font: 'inherit',
              }}
              maxLength={200}
            />
          </div>
          {!editingTask && (
            <div
              className="wf-row wf-gap-6"
              style={{ paddingLeft: 2, marginTop: 2, cursor: 'pointer' }}
              onClick={() => setAddToCatalog(!addToCatalog)}
            >
              <span className={`wf-check${addToCatalog ? ' done' : ''}`}>
                {addToCatalog && <Icon name="check" />}
              </span>
              <span className="wf-tiny">{t('create.addToCatalog')}</span>
            </div>
          )}
        </div>

        {/* Type Seg */}
        <span className="wf-tiny">{t('create.field.type')}</span>
        <Seg
          full
          items={Object.values(KIND_LABELS) as string[]}
          active={KIND_LABELS[kind]}
          onChange={(label) => setKind(KIND_BY_LABEL[label] ?? 'oneoff')}
        />

        {/* Per-kind fields */}
        {kind === 'oneoff' && (
          <div className="wf-col wf-gap-6" style={{ marginTop: 10 }}>
            <div className="wf-spread">
              <span className="wf-tiny">{t('create.field.date')}</span>
              {/* "Без даты" toggle — when on, the date field is suppressed and
                  the payload becomes floating + singleShot (one-time task
                  living in "Когда-нибудь" until someone completes it). */}
              <span
                className="wf-row wf-gap-6"
                style={{ cursor: 'pointer' }}
                onClick={() => setNoDate(!noDate)}
              >
                <span className="wf-tiny">{t('create.noDate')}</span>
                <MiniToggle on={noDate} />
              </span>
            </div>
            {!noDate && (
              <div className="wf-box" style={{ padding: '8px 10px' }}>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
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
            {noDate && <span className="wf-hint">{t('create.noDate.hint')}</span>}
          </div>
        )}
        {kind === 'recurring' && (
          <div className="wf-col wf-gap-6" style={{ marginTop: 10 }}>
            <span className="wf-tiny">{t('create.field.daysOfWeek')}</span>
            <div className="wf-row wf-gap-4">
              {DAY_PILLS.map((d) => {
                const active = daysOfWeek.includes(d.id);
                return (
                  <span
                    key={d.id}
                    className={'wf-tag' + (active ? ' solid' : '')}
                    style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
                    onClick={() =>
                      setDaysOfWeek((curr) =>
                        active ? curr.filter((x) => x !== d.id) : [...curr, d.id].sort(),
                      )
                    }
                  >
                    {d.label}
                  </span>
                );
              })}
            </div>
          </div>
        )}
        {/* Floating: optional "однократно" toggle to make it a one-shot task. */}
        {kind === 'floating' && (
          <div className="wf-spread" style={{ marginTop: 10 }}>
            <span className="wf-tiny">{t('create.field.singleShot')}</span>
            <span style={{ cursor: 'pointer' }} onClick={() => setSingleShot(!singleShot)}>
              <MiniToggle on={singleShot} />
            </span>
          </div>
        )}
        {/* Cooldown applies to anything that can re-fire: recurring, floating,
            and queued. (User reported "по очереди тоже должна быть с кд".) */}
        {(kind === 'recurring' || kind === 'floating' || kind === 'queued') && (
          <div className="wf-row wf-gap-6" style={{ marginTop: 6 }}>
            <span className="wf-tiny" style={{ flex: 1 }}>
              {t('create.field.cooldown')}
            </span>
            <CooldownPicker
              value={cooldownDays}
              onChange={setCooldownDays}
              options={COOLDOWN_OPTIONS}
            />
          </div>
        )}

        {/* Queue roster — multi-select for queued tasks. null means "all
            members" (server default); flipping any checkbox opts into an
            explicit list. Owner of the queue isn't auto-selected — the
            user picks who shares the chore. */}
        {kind === 'queued' && members.length > 0 && (
          <div className="wf-col wf-gap-4" style={{ marginTop: 10 }}>
            <div className="wf-spread">
              <span className="wf-tiny">
                {t.locale === 'en' ? 'Queue members' : 'Участники очереди'}
              </span>
              <span className="wf-hint" style={{ fontSize: 11 }}>
                {queueUserIds === null
                  ? t.locale === 'en'
                    ? 'all'
                    : 'все'
                  : `${queueUserIds.length}/${members.length}`}
              </span>
            </div>
            <div className="wf-col wf-gap-2">
              {members.map((m) => {
                const explicit = queueUserIds;
                const selected = explicit === null ? true : explicit.includes(m.id);
                return (
                  <div
                    key={m.id}
                    className="wf-row wf-gap-8"
                    onClick={() => {
                      // Switch from implicit "all" to explicit list on
                      // first interaction, then toggle the clicked member.
                      const base = explicit === null ? members.map((mm) => mm.id) : [...explicit];
                      const idx = base.indexOf(m.id);
                      if (idx >= 0) base.splice(idx, 1);
                      else base.push(m.id);
                      // If the user ended up unchecking everyone, fall back to
                      // null (server default = all) so the task isn't broken.
                      setQueueUserIds(base.length === 0 ? null : base);
                    }}
                    style={{
                      padding: '6px 4px',
                      cursor: 'pointer',
                      borderRadius: 6,
                    }}
                  >
                    <span
                      className={'wf-check' + (selected ? ' done' : '')}
                      style={{ pointerEvents: 'none' }}
                    >
                      {selected && <Icon name="check" />}
                    </span>
                    <Av m={m} size="sm" />
                    <span
                      className="wf-label"
                      style={{
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {m.name}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Row: Ответственный + Дедлайн */}
        <div className="wf-row wf-gap-8" style={{ marginTop: 10 }}>
          <div className="wf-col wf-gap-2" style={{ flex: 1 }}>
            <span className="wf-tiny">{t('create.field.assignee')}</span>
            <div
              className="wf-box"
              style={{ padding: '8px 10px', cursor: 'pointer' }}
              onClick={cycleAssignee}
            >
              {assignee ? (
                <div className="wf-row wf-gap-6">
                  <Av m={assignee} size="sm" />
                  <span className="wf-label">{assignee.name}</span>
                </div>
              ) : (
                <span className="wf-label" style={{ color: 'var(--hint)' }}>
                  {t('create.assignee.unassigned')}
                </span>
              )}
            </div>
          </div>
          <div className="wf-col wf-gap-2" style={{ flex: 1 }}>
            <span className="wf-tiny">{t('create.field.deadline')}</span>
            <div className="wf-box" style={{ padding: '8px 10px' }}>
              <input
                type="date"
                value={deadlineAt?.slice(0, 10) ?? ''}
                onChange={(e) =>
                  setDeadlineAt(e.target.value ? `${e.target.value}T23:59:00.000Z` : null)
                }
                className="wf-label"
                placeholder={t('create.deadline.empty')}
                style={{
                  width: '100%',
                  border: 'none',
                  background: 'transparent',
                  outline: 'none',
                  color: deadlineAt ? 'var(--ink)' : 'var(--hint)',
                  font: 'inherit',
                }}
              />
            </div>
          </div>
        </div>

        {/* Tags — multi-select chips. Tag list fetched lazily; pressing
            "+" prompts for a name to spin up a new tag inline. */}
        <span className="wf-tiny" style={{ marginTop: 10 }}>
          {t('create.tags.title')}
        </span>
        <TagPicker familyId={family.id} value={tagIds} onChange={setTagIds} />

        {/* Subtasks — checklist editor. Empty list = no checklist.
            Each non-empty line becomes a subtask on save. The bottom input
            is always an empty row for fast adding (Enter = commit + new row). */}
        <span className="wf-tiny" style={{ marginTop: 10 }}>
          {t('create.subtasks.title')}
        </span>
        <div className="wf-col wf-gap-4" style={{ marginTop: 4 }}>
          {subtaskTitles.map((s, idx) => (
            <div key={idx} className="wf-row wf-gap-6">
              <span className="wf-check" style={{ flex: 'none' }} />
              <div className="wf-box" style={{ flex: 1, padding: '6px 10px' }}>
                <input
                  value={s}
                  onChange={(e) => {
                    const next = [...subtaskTitles];
                    next[idx] = e.target.value;
                    setSubtaskTitles(next);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      // Commit-and-add-row UX: Enter at the last input
                      // pushes a fresh empty row and moves focus to it
                      // (focus shift happens naturally via DOM mount).
                      if (idx === subtaskTitles.length - 1 && s.trim()) {
                        setSubtaskTitles([...subtaskTitles, '']);
                      }
                    }
                  }}
                  placeholder={t('create.subtasks.placeholder')}
                  className="wf-label"
                  style={{
                    width: '100%',
                    border: 'none',
                    background: 'transparent',
                    outline: 'none',
                    color: 'var(--ink)',
                    font: 'inherit',
                  }}
                  maxLength={200}
                />
              </div>
              <button
                type="button"
                onClick={() =>
                  setSubtaskTitles(subtaskTitles.filter((_, i) => i !== idx))
                }
                aria-label={t('common.delete')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '0 4px',
                  color: 'var(--hint)',
                  flex: 'none',
                }}
              >
                <Icon name="x" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="wf-btn ghost"
            onClick={() => setSubtaskTitles([...subtaskTitles, ''])}
            style={{
              cursor: 'pointer',
              alignSelf: 'flex-start',
              padding: '4px 10px',
              fontSize: 12,
            }}
          >
            + {t('create.subtasks.add')}
          </button>
        </div>

        {/* Row: Награда + Фото */}
        <div className="wf-row wf-gap-8" style={{ marginTop: 10 }}>
          <div className="wf-col wf-gap-2" style={{ flex: 1 }}>
            <span className="wf-tiny">{t('create.field.reward')}</span>
            <div className="wf-box" style={{ padding: '8px 10px' }}>
              <div className="wf-row wf-gap-6" style={{ alignItems: 'baseline' }}>
                <span className="wf-label">+</span>
                <input
                  type="number"
                  min={0}
                  max={10000}
                  value={points}
                  onChange={(e) => setPoints(Number(e.target.value) || 0)}
                  className="wf-label"
                  style={{
                    width: 40,
                    border: 'none',
                    background: 'transparent',
                    outline: 'none',
                    color: 'var(--ink)',
                    font: 'inherit',
                    fontWeight: 600,
                    padding: 0,
                  }}
                />
                <span className="wf-label">{t('create.field.reward.points')}</span>
              </div>
            </div>
          </div>
          <div className="wf-col wf-gap-2" style={{ flex: 1 }}>
            <span className="wf-tiny">{t('create.field.photo')}</span>
            <div
              className="wf-box wf-spread"
              style={{ padding: '6px 10px', cursor: 'pointer' }}
              onClick={() => setPhotoRequired(!photoRequired)}
            >
              <span className="wf-label">
                {photoRequired ? t('create.photo.required') : t('create.photo.optional')}
              </span>
              <span
                style={{
                  width: 28,
                  height: 16,
                  background: photoRequired ? 'var(--ink)' : 'var(--softline)',
                  borderRadius: 999,
                  position: 'relative',
                  flex: 'none',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    left: photoRequired ? 14 : 2,
                    top: 2,
                    width: 12,
                    height: 12,
                    borderRadius: 999,
                    background: 'var(--paper)',
                    transition: 'left 0.15s ease',
                  }}
                />
              </span>
            </div>
          </div>
        </div>

        {mutation.error && (
          <div
            className="wf-card"
            style={{ borderColor: 'var(--danger)', color: 'var(--danger)', marginTop: 10 }}
          >
            {describeError(mutation.error as ApiError, t)}
          </div>
        )}

        {/* Submit: Шаблон + Создать (or Delete + Сохранить in edit mode) */}
        <div className="wf-row wf-gap-8" style={{ marginTop: 12 }}>
          {editingTask ? (
            <button
              className="wf-btn danger"
              onClick={() => {
                if (window.confirm(t('create.confirm.delete'))) {
                  deleteMut.mutate(undefined, { onSuccess: finish });
                }
              }}
              disabled={deleteMut.isPending}
              style={{ cursor: deleteMut.isPending ? 'default' : 'pointer' }}
            >
              <Icon name="trash" />
            </button>
          ) : (
            <button
              className="wf-btn ghost"
              onClick={() => setSaveAsTemplate(!saveAsTemplate)}
              title={t('create.template')}
              style={{
                cursor: 'pointer',
                ...(saveAsTemplate
                  ? {
                      background: 'var(--ink)',
                      color: 'var(--paper)',
                      borderStyle: 'solid',
                      borderColor: 'var(--ink)',
                    }
                  : null),
              }}
            >
              {saveAsTemplate ? t('create.template.on') : t('create.template')}
            </button>
          )}
          <button
            className="wf-btn primary lg"
            onClick={() => mutation.mutate(undefined, { onSuccess: finish })}
            disabled={!canSubmit}
            style={{ flex: 1, cursor: canSubmit ? 'pointer' : 'default', opacity: canSubmit ? 1 : 0.5 }}
          >
            {mutation.isPending
              ? editingTask
                ? t('common.saving')
                : t('common.creating')
              : editingTask
                ? t('common.save')
                : t('common.create')}
          </button>
        </div>
      </>
        );
      }}
    </BottomSheet>
  );
}

function CooldownPicker({
  value,
  onChange,
  options,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  options: Array<{ value: number | null; label: string }>;
}) {
  const idx = options.findIndex((o) => o.value === value);
  const cur = options[idx >= 0 ? idx : 0]!;
  const cycle = () => {
    const next = options[(idx + 1) % options.length]!;
    onChange(next.value);
  };
  return (
    <span className="wf-tag" onClick={cycle} style={{ cursor: 'pointer' }}>
      {cur.label}
    </span>
  );
}

function buildPayload(input: {
  title: string;
  kind: TaskKind;
  date: string;
  daysOfWeek: number[];
  cooldownDays: number | null;
  assigneeId: string | null;
  queueUserIds: string[] | null;
  points: number;
  photoRequired: boolean;
  deadlineAt: string | null;
  noDate: boolean;
  singleShot: boolean;
  subtasks: Array<{ title: string }>;
  tagIds: string[];
}): CreateTaskPayload {
  const base = {
    title: input.title,
    assigneeId: input.assigneeId,
    // Only send queueUserIds for queued tasks. Other types ignore it
    // server-side, but it's cleaner to omit.
    queueUserIds: input.kind === 'queued' ? input.queueUserIds : undefined,
    points: input.points,
    photoRequired: input.photoRequired,
    deadlineAt: input.deadlineAt,
    // singleShot + cooldownDays + subtasks piggyback on the API client's
    // permissive payload type — the backend's createTaskSchema accepts them.
    singleShot: input.singleShot || (input.kind === 'oneoff' && input.noDate),
    cooldownDays: input.cooldownDays,
    subtasks: input.subtasks.length > 0 ? input.subtasks : undefined,
    tagIds: input.tagIds,
  } as unknown as CreateTaskPayload;
  switch (input.kind) {
    case 'oneoff':
      // "Разовая без даты" → store as floating+singleShot so it lives in
      // «Когда-нибудь» until someone completes it once.
      if (input.noDate) {
        return { ...base, type: 'floating', schedule: { kind: 'floating' } };
      }
      return { ...base, type: 'oneoff', schedule: { kind: 'oneoff', date: input.date } };
    case 'recurring':
      return {
        ...base,
        type: 'recurring',
        schedule:
          input.daysOfWeek.length === 7
            ? { kind: 'recurring', recurrence: 'daily' }
            : { kind: 'recurring', recurrence: 'weekly', daysOfWeek: input.daysOfWeek },
      };
    case 'floating':
      return { ...base, type: 'floating', schedule: { kind: 'floating' } };
    case 'queued':
      return { ...base, type: 'queued', schedule: { kind: 'queued' } };
  }
}

function MiniToggle({ on }: { on: boolean }) {
  return (
    <span
      style={{
        width: 28,
        height: 16,
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
          left: on ? 14 : 2,
          top: 2,
          width: 12,
          height: 12,
          borderRadius: 999,
          background: 'var(--paper)',
          transition: 'left 0.15s ease',
        }}
      />
    </span>
  );
}

function describeError(err: ApiError, t: ReturnType<typeof useT>): string {
  const body = err.body as { error?: string; permission?: string } | null;
  if (body?.error === 'forbidden') return t('create.err.forbidden');
  return err.message;
}

function extractFromTask(t: TaskDto): {
  title: string;
  kind: TaskKind;
  date: string;
  daysOfWeek: number[];
  cooldownDays: number | null;
  points: number;
  photoRequired: boolean;
  deadlineAt: string | null;
  assigneeId: string | null;
  queueUserIds: string[] | null;
  noDate: boolean;
  singleShot: boolean;
  subtasks: string[];
  tagIds: string[];
} {
  const sched = t.schedule as
    | { kind: 'oneoff'; date: string }
    | {
        kind: 'recurring';
        recurrence: 'daily' | 'weekly' | 'interval';
        daysOfWeek?: number[];
      }
    | { kind: 'floating' }
    | { kind: 'queued' };
  let days = [1, 2, 3, 4, 5];
  if (sched.kind === 'recurring' && sched.recurrence === 'daily') {
    days = [0, 1, 2, 3, 4, 5, 6];
  } else if (sched.kind === 'recurring' && sched.recurrence === 'weekly' && sched.daysOfWeek) {
    days = sched.daysOfWeek;
  }
  return {
    title: t.title,
    kind: t.type,
    date: sched.kind === 'oneoff' ? sched.date : new Date().toISOString().slice(0, 10),
    daysOfWeek: days,
    cooldownDays: t.cooldownDays,
    points: t.points,
    photoRequired: t.photoRequired,
    deadlineAt: t.deadlineAt,
    assigneeId: t.assigneeId,
    queueUserIds: t.queueUserIds,
    noDate: false,
    singleShot: t.singleShot,
    subtasks: (t.subtasksTemplate ?? []).map((s) => s.title),
    tagIds: t.tagIds ?? [],
  };
}

/**
 * Inline multi-select for tag attachments. Fetches the family's tag list
 * lazily (TanStack cache) and renders each as a toggle chip; tapping
 * flips its membership in `value`. Pressing the "+ Новый тег" chip
 * prompts for a name and creates a tag on the fly, then auto-selects it.
 * Empty state collapses to just the "+" — discoverable without yelling
 * if the family hasn't created any tags yet.
 */
function TagPicker({
  familyId,
  value,
  onChange,
}: {
  familyId: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const tagsQuery = useQuery({
    queryKey: ['tags', familyId],
    queryFn: () => api.listTags(familyId),
  });
  const createMut = useMutation({
    mutationFn: (name: string) => api.createTag(familyId, { name }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['tags', familyId] });
      onChange([...value, res.tag.id]);
    },
  });
  const tags = tagsQuery.data?.tags ?? [];
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="wf-row wf-gap-6" style={{ flexWrap: 'wrap', marginTop: 4 }}>
      {tags.map((tg) => {
        const active = value.includes(tg.id);
        return (
          <button
            key={tg.id}
            type="button"
            onClick={() => toggle(tg.id)}
            style={{
              background: active ? tg.color ?? 'var(--ink)' : 'transparent',
              color: active ? 'var(--paper)' : 'var(--ink)',
              border: `1.5px solid ${active ? tg.color ?? 'var(--ink)' : 'var(--line)'}`,
              borderRadius: 999,
              padding: '4px 10px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              font: 'inherit',
              lineHeight: 1.2,
            }}
          >
            {tg.name}
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => {
          const name = window.prompt(t('create.tags.namePrompt'));
          if (!name?.trim()) return;
          createMut.mutate(name.trim());
        }}
        disabled={createMut.isPending}
        style={{
          background: 'transparent',
          color: 'var(--hint)',
          border: '1.5px dashed var(--softline)',
          borderRadius: 999,
          padding: '4px 10px',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
          font: 'inherit',
          lineHeight: 1.2,
        }}
      >
        + {t('create.tags.add')}
      </button>
    </div>
  );
}
