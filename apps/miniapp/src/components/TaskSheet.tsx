import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
  type OccurrenceDto,
  type PhotoDto,
} from '../api';
import { Av, Bar, Icon, Tag, type Member } from '../design';
import { BottomSheet } from './BottomSheet';
import { useToast } from './Toast';
import { useT } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  occurrence: OccurrenceDto;
  onClose: () => void;
  onEdit?: () => void;
  onTransfer?: () => void;
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
 * Port of TSV1 (screens-templates-tasksheet-stats.jsx lines 145-212).
 * Bottom-sheet detail showing all metadata + actions. Photo upload is rendered
 * as a placeholder until the API supports it.
 */
export function TaskSheet({ me, family, occurrence, onClose, onEdit, onTransfer }: Props) {
  const queryClient = useQueryClient();
  const t = useT();
  const o = occurrence;

  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });
  const members = useMemo(
    () => (membersQuery.data?.members ?? []).map(memberFromDto),
    [membersQuery.data],
  );
  const assignee = o.assigneeId ? members.find((m) => m.id === o.assigneeId) ?? null : null;

  // We hoist the mutation hooks but defer success-side closing to inside the
  // BottomSheet render so we can pipe it through `close()` (animated exit).
  const completeMut = useMutation({
    // Floating tasks open the sheet via a synth `floating:<taskId>` occurrence
    // id (no real occurrence exists yet). Route those through the dedicated
    // /complete-floating endpoint that creates the occurrence server-side.
    mutationFn: () => {
      if (o.id.startsWith('floating:')) {
        const taskId = o.id.slice('floating:'.length);
        return api.completeFloatingTask(family.id, taskId);
      }
      return api.completeOccurrence(family.id, o.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] });
      queryClient.invalidateQueries({ queryKey: ['tasks', family.id] });
    },
  });
  const uncompleteMut = useMutation({
    mutationFn: () => api.uncompleteOccurrence(family.id, o.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] });
    },
  });

  // Subtask checkbox toggle. Floating-synth ids and done occurrences are
  // both read-only — see the `canEditSubtasks` guard below in the render.
  // Optimistic update keeps the click instant; the server response will
  // overwrite via the standard occurrences-list invalidate.
  const subtaskMut = useMutation({
    mutationFn: (input: { subtaskId: string; done: boolean }) =>
      api.updateSubtasksState(family.id, o.id, [
        { id: input.subtaskId, done: input.done },
      ]),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] });
      queryClient.invalidateQueries({ queryKey: ['occurrence', family.id, o.id] });
    },
  });
  // Local override so the click feels instant. We merge with `o.subtasks`
  // on render. Cleared when the server result arrives (key changes on
  // refetch because the occurrence prop is replaced from parent).
  const [optimisticPatch, setOptimisticPatch] = useState<Record<string, boolean>>({});

  // Reschedule (date change) + stop-repeat (task archive). Stop-repeat is
  // really `archiveTask` on the backend (DELETE /tasks/:id) — for recurring
  // tasks it stops new occurrences from being generated; pending occurrences
  // hide via `archivedAt` filter in listFamilyOccurrences.
  const rescheduleMut = useMutation({
    mutationFn: (scheduledDate: string) =>
      api.rescheduleOccurrence(family.id, o.id, scheduledDate),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] });
      queryClient.invalidateQueries({ queryKey: ['occurrence', family.id, o.id] });
    },
  });
  const toast = useToast();
  const stopRepeatMut = useMutation({
    mutationFn: () => api.deleteTask(family.id, o.taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] });
      queryClient.invalidateQueries({ queryKey: ['tasks', family.id] });
      // Undo toast — soft-delete on the backend (archivedAt) lets us POST
      // restore from here. Capture `o.taskId` in the closure since the
      // sheet animates closed immediately after this success runs.
      const taskId = o.taskId;
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
    },
  });
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  // Snooze opens a small inline popover with preset offsets (tomorrow / +3 /
  // weekend / week). It piggybacks on `rescheduleMut` — same backend call
  // with a precomputed date — so we don't need a second mutation.
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  // Photos live in Telegram now — we list them by occurrence (or task for
  // synth floating). `o.photoIds` from older completions is ignored.
  const photoQueryKey = useMemo(() => {
    if (o.id.startsWith('floating:')) {
      return ['photos', 'task', family.id, o.taskId] as const;
    }
    return ['photos', 'occ', family.id, o.id] as const;
  }, [family.id, o.id, o.taskId]);
  const photosQuery = useQuery({
    queryKey: photoQueryKey,
    queryFn: () => {
      if (o.id.startsWith('floating:')) {
        return api.listPhotosByTask(family.id, o.taskId);
      }
      return api.listPhotosByOccurrence(family.id, o.id);
    },
  });
  const photos: PhotoDto[] = photosQuery.data?.photos ?? [];

  // Optimistic upload: the moment a file is picked, we render a thumbnail
  // from a blob URL with a spinner overlay. The real thumb (via Telegram
  // CDN) replaces it once the server-side upload finishes and the photo
  // list refetches. We keep multiple pending uploads in flight (the cap
  // is enforced server-side via PHOTO_MAX_COUNT_PER_OCCURRENCE).
  const [pendingUploads, setPendingUploads] = useState<
    Array<{ key: string; previewUrl: string; error: string | null }>
  >([]);
  const removePending = (key: string) => {
    setPendingUploads((prev) => {
      const target = prev.find((p) => p.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  };
  const uploadFile = (file: File) => {
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const previewUrl = URL.createObjectURL(file);
    setPendingUploads((prev) => [...prev, { key, previewUrl, error: null }]);
    api
      .uploadPhoto(family.id, o.id, file)
      .then(() => {
        queryClient.invalidateQueries({ queryKey: photoQueryKey });
        removePending(key);
      })
      .catch((err: unknown) => {
        const msg = err instanceof ApiError ? describeError(err, t) : (err as Error).message;
        setPendingUploads((prev) =>
          prev.map((p) => (p.key === key ? { ...p, error: msg } : p)),
        );
      });
  };
  // Revoke any leftover blob URLs on unmount — preventing leaks if the user
  // closes the sheet mid-upload (the upload promise still resolves, but
  // there's nothing to invalidate; the blob URL is orphaned otherwise).
  useEffect(() => {
    return () => {
      for (const p of pendingUploads) URL.revokeObjectURL(p.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const deletePhotoMut = useMutation({
    mutationFn: (photoId: string) => api.deletePhoto(family.id, photoId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: photoQueryKey });
    },
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  const done = o.status === 'done';
  const isCompleter = o.completedBy === me.id;
  const isAssignee = o.assigneeId === me.id;
  const photoMissing = o.task.photoRequired && photos.length === 0;
  // Merge optimistic toggles into the server-known subtask list so the
  // checkbox flips instantly on click. The patch is cleared on each new
  // occurrence reference from the parent.
  const subtasks = useMemo(
    () =>
      (o.subtasks ?? []).map((s) =>
        s.id in optimisticPatch ? { ...s, done: optimisticPatch[s.id]! } : s,
      ),
    [o.subtasks, optimisticPatch],
  );
  const subtasksDone = subtasks.filter((s) => s.done).length;
  // Subtasks are editable only while the occurrence is still pending AND
  // it's not a synth `floating:<taskId>` id (those have no row to PATCH).
  const canEditSubtasks =
    !done && !o.id.startsWith('floating:') && subtasks.length > 0;

  return (
    <BottomSheet onClose={onClose} zIndex={10}>
      {({ close }) => (
      <>
        

        {/* Header — port of lines 157-160 */}
        <div className="wf-row wf-gap-8">
          <span className="wf-h2" style={{ flex: 1 }}>
            {o.task.title}
          </span>
          {onEdit && (
            <button
              onClick={() => close(onEdit)}
              aria-label={t('common.edit')}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--ink)' }}
            >
              <Icon name="edit" />
            </button>
          )}
          <button
            onClick={() => close()}
            aria-label={t('common.close')}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--ink)' }}
          >
            <Icon name="x" />
          </button>
        </div>

        {/* Tags — port of lines 162-168 */}
        <div className="wf-row wf-gap-6" style={{ marginTop: 6, flexWrap: 'wrap' }}>
          {assignee && (
            <Tag>
              <Av m={assignee} size="xs" />
              &nbsp;{assignee.name}
            </Tag>
          )}
          {o.task.type === 'recurring' && (
            <Tag>
              <Icon name="repeat" />
              &nbsp;{t('task.tag.recurring')}
            </Tag>
          )}
          {o.task.type === 'queued' && <Tag>{t('task.tag.queued')}</Tag>}
          {o.task.type === 'floating' && <Tag>{t('task.tag.floating')}</Tag>}
          {o.task.deadlineAt && (
            <Tag variant="warn">
              {t('task.tag.deadline')} {fmtDeadline(o.task.deadlineAt)}
            </Tag>
          )}
          {o.task.points > 0 && (
            <Tag>
              +{o.task.points} {t('task.tag.points')}
            </Tag>
          )}
          {o.task.photoRequired && (
            <Tag variant={photoMissing ? 'danger' : undefined}>
              <Icon name="cam" />
              &nbsp;{t('task.tag.photo')}
            </Tag>
          )}
        </div>

        {/* Subtasks — port of lines 173-181.
            Quest mode: the first not-done step is the "active" one; any
            step after it renders locked (no click target) until the
            active one is ticked. Done steps stay clickable so the user
            can undo a wrong tap. */}
        {subtasks.length > 0 && (() => {
          const isQuest = o.task.isQuest;
          const activeIdx = subtasks.findIndex((s) => !s.done);
          return (
          <>
            <div className="wf-spread" style={{ marginTop: 12 }}>
              <span className="wf-tiny">
                {isQuest ? '🎯 ' : ''}
                {t('task.subtasks.title')} · {subtasksDone}/{subtasks.length}
              </span>
              <Bar pct={(subtasksDone / subtasks.length) * 100} />
            </div>
            <div className="wf-col wf-gap-4" style={{ marginTop: 4 }}>
              {subtasks.map((s, idx) => {
                // In quest mode, a step is locked when it's strictly after
                // the first undone step. `activeIdx === -1` (all done) ⇒
                // nothing is locked; done steps remain clickable to undo.
                const locked =
                  isQuest && activeIdx !== -1 && idx > activeIdx;
                const toggle = () => {
                  if (!canEditSubtasks || locked) return;
                  const next = !s.done;
                  setOptimisticPatch((prev) => ({ ...prev, [s.id]: next }));
                  subtaskMut.mutate(
                    { subtaskId: s.id, done: next },
                    {
                      onError: () => {
                        setOptimisticPatch((prev) => {
                          const copy = { ...prev };
                          delete copy[s.id];
                          return copy;
                        });
                      },
                    },
                  );
                };
                return (
                  <div
                    key={s.id}
                    className="wf-row wf-gap-6"
                    onClick={toggle}
                    style={{
                      cursor:
                        canEditSubtasks && !locked ? 'pointer' : 'default',
                      opacity: locked ? 0.4 : 1,
                    }}
                  >
                    <span className={'wf-check' + (s.done ? ' done' : '')}>
                      {s.done && <Icon name="check" />}
                      {locked && !s.done && <span style={{ fontSize: 11 }}>🔒</span>}
                    </span>
                    <span
                      className="wf-label"
                      style={
                        s.done
                          ? { textDecoration: 'line-through', color: 'var(--hint)' }
                          : undefined
                      }
                    >
                      {s.title}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
          );
        })()}

        {/* Photo section — Telegram-native storage.
            While the task is pending we show the upload affordance even when
            photos aren't required (the design supports optional proof). Once
            it's done we only show *existing* photos — no add button (the
            user can still delete via the inline keyboard in their bot chat). */}
        {(() => {
          if (done && photos.length === 0) return null;
          return (
            <>
              <span className="wf-tiny" style={{ marginTop: 12 }}>
                {t('task.photo.title')}
                {!done && !o.task.photoRequired && (
                  <span
                    className="wf-hint"
                    style={{ marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}
                  >
                    · {t('common.optional')}
                  </span>
                )}
              </span>
              <div className="wf-row wf-gap-6" style={{ marginTop: 4, flexWrap: 'wrap' }}>
                {photos.map((p) => (
                  <PhotoThumb
                    key={p.id}
                    photo={p}
                    family={family}
                    canDelete={!done && (p.userId === me.id)}
                    onDelete={() => deletePhotoMut.mutate(p.id)}
                  />
                ))}
                {/* Optimistic pending tiles — replaced once the server
                    upload completes and the photos query invalidates. */}
                {pendingUploads.map((u) => (
                  <PendingPhotoThumb
                    key={u.key}
                    previewUrl={u.previewUrl}
                    error={u.error}
                    onDismiss={() => removePending(u.key)}
                  />
                ))}
                {!done && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) uploadFile(f);
                        e.target.value = '';
                      }}
                    />
                    <AddPhotoBtn
                      danger={photoMissing}
                      busy={false}
                      onClick={() => fileInputRef.current?.click()}
                    />
                  </>
                )}
              </div>
            </>
          );
        })()}

        {completeMut.error && (
          <div
            className="wf-card"
            style={{ borderColor: 'var(--danger)', color: 'var(--danger)', marginTop: 10 }}
          >
            {describeError(completeMut.error as ApiError, t)}
          </div>
        )}

        {/* Actions — only the assignee can transfer / reschedule / complete
            their own turn (or uncomplete a finished one). Other family
            members see the task read-only; their own management actions
            ("Stop repeating" below) live in a separate block.
            Layout: primary "Выполнить" gets a full-width row by itself
            so it's never clipped on narrow screens; secondary actions
            (Передать / Отложить / Перенести) sit on a flex-wrapping
            row below where they can break into a second line if needed.
            Previously all four were on one row which clipped "Выполнить"
            on standard phone viewports. */}
        {(!done && isAssignee) || (done && (isCompleter || isAssignee)) ? (
          <div
            className="wf-col"
            style={{ marginTop: 12, gap: 8 }}
          >
            {!done && isAssignee && (
              <>
                <button
                  className="wf-btn primary"
                  style={{
                    width: '100%',
                    cursor: photoMissing ? 'not-allowed' : 'pointer',
                    opacity: photoMissing ? 0.5 : 1,
                  }}
                  onClick={() => {
                    if (photoMissing) return;
                    completeMut.mutate(undefined, { onSuccess: () => close() });
                  }}
                  disabled={completeMut.isPending || photoMissing}
                >
                  {completeMut.isPending
                    ? t('task.action.completing')
                    : t('task.action.complete')}
                </button>
                <div
                  className="wf-row wf-gap-8"
                  style={{ flexWrap: 'wrap' }}
                >
                  <button
                    className="wf-btn"
                    onClick={() => onTransfer && close(onTransfer)}
                    disabled={!onTransfer}
                    style={{
                      cursor: onTransfer ? 'pointer' : 'not-allowed',
                      flex: '1 1 auto',
                    }}
                  >
                    {t('task.action.transfer')}
                  </button>
                  {/* Reschedule + Snooze are only meaningful for dated
                      occurrences. Floating tasks have no scheduledDate. */}
                  {!o.id.startsWith('floating:') && o.task.type !== 'floating' && (
                    <>
                      <button
                        className="wf-btn"
                        onClick={() => setSnoozeOpen((v) => !v)}
                        style={{ cursor: 'pointer', flex: '1 1 auto' }}
                      >
                        {t('task.action.snooze')}
                      </button>
                      <button
                        className="wf-btn"
                        onClick={() => setRescheduleOpen(true)}
                        style={{ cursor: 'pointer', flex: '1 1 auto' }}
                      >
                        {t('task.action.reschedule')}
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
            {done && (
              <button
                className="wf-btn block"
                onClick={() => uncompleteMut.mutate(undefined, { onSuccess: () => close() })}
                disabled={uncompleteMut.isPending}
                style={{
                  cursor: uncompleteMut.isPending ? 'default' : 'pointer',
                  opacity: uncompleteMut.isPending ? 0.5 : 1,
                  width: '100%',
                }}
              >
                {uncompleteMut.isPending ? '…' : t('task.action.uncomplete')}
              </button>
            )}
          </div>
        ) : null}
        {snoozeOpen && !done && (
          <div
            className="wf-card"
            style={{
              marginTop: 8,
              padding: 6,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {snoozeOptions(o.scheduledDate, t).map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => {
                  rescheduleMut.mutate(opt.iso, {
                    onSuccess: () => {
                      setSnoozeOpen(false);
                      close();
                    },
                  });
                }}
                disabled={rescheduleMut.isPending}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  padding: '8px 10px',
                  borderRadius: 8,
                  font: 'inherit',
                  color: 'var(--ink)',
                }}
              >
                <span>{opt.label}</span>
                <span className="wf-tiny" style={{ marginLeft: 8, color: 'var(--hint)' }}>
                  {opt.iso}
                </span>
              </button>
            ))}
          </div>
        )}
        {photoMissing && (
          <span
            className="wf-tiny"
            style={{ display: 'block', marginTop: 4, color: 'var(--hint)', textAlign: 'center' }}
          >
            {t('task.photo.required')}
          </span>
        )}

        {/* Stop-repeating action — shown only for recurring/queued tasks
            that are still active. Archives the task on the backend, so no
            new occurrences are generated and pending ones disappear from
            the list. */}
        {!done &&
          (o.task.type === 'recurring' || o.task.type === 'queued') &&
          !o.id.startsWith('floating:') && (
            <button
              type="button"
              className="wf-btn danger ghost block"
              onClick={() => {
                const msg =
                  t.locale === 'en'
                    ? 'Stop this task from repeating? Pending occurrences will be cleared. Past history is kept.'
                    : 'Прекратить повтор задачи? Все ожидающие повторы пропадут. История останется.';
                if (window.confirm(msg)) {
                  stopRepeatMut.mutate(undefined, { onSuccess: () => close() });
                }
              }}
              disabled={stopRepeatMut.isPending}
              style={{
                marginTop: 8,
                cursor: stopRepeatMut.isPending ? 'default' : 'pointer',
                opacity: stopRepeatMut.isPending ? 0.5 : 1,
              }}
            >
              {stopRepeatMut.isPending
                ? '…'
                : t.locale === 'en'
                  ? 'Stop repeating'
                  : 'Прекратить повторы'}
            </button>
          )}
        {rescheduleMut.error && (
          <div
            className="wf-card"
            style={{ borderColor: 'var(--danger)', color: 'var(--danger)', marginTop: 8 }}
          >
            {describeRescheduleError(rescheduleMut.error as ApiError, t)}
          </div>
        )}
        {rescheduleOpen && (
          <ReschedulePicker
            initialDate={o.scheduledDate ?? new Date().toISOString().slice(0, 10)}
            onClose={() => setRescheduleOpen(false)}
            onPick={(d) => {
              rescheduleMut.mutate(d, {
                onSuccess: () => {
                  setRescheduleOpen(false);
                  close();
                },
              });
            }}
          />
        )}

        {/* Comments thread — separate component to keep this file focused.
            Lazy-fetched on sheet open so closed sheets don't waste a
            request; in-place compose + delete-own. */}
        <CommentsSection me={me} family={family} taskId={o.taskId} members={members} />

        {/* History — port of lines 202-208 */}
        {o.completedAt && done && (
          <>
            <span className="wf-tiny" style={{ marginTop: 12 }}>
              {t('task.history.done')}
            </span>
            <div className="wf-row wf-gap-6" style={{ marginTop: 4 }}>
              {o.completedBy && (
                <Av
                  m={members.find((m) => m.id === o.completedBy) ?? null}
                  size="xs"
                />
              )}
              <span className="wf-tiny">{fmtCompletedAt(o.completedAt)}</span>
            </div>
          </>
        )}
      </>
      )}
    </BottomSheet>
  );
}

/**
 * Optimistic pending-upload tile. Same dimensions as PhotoThumb so the
 * layout doesn't shift when the real thumb replaces it. While the upload
 * is in flight, the tile dims the preview and overlays a spinner. On
 * error, an "×" button lets the user dismiss the tile.
 */
function PendingPhotoThumb({
  previewUrl,
  error,
  onDismiss,
}: {
  previewUrl: string;
  error: string | null;
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        position: 'relative',
        width: 56,
        height: 56,
        borderRadius: 8,
        border: `1.5px solid ${error ? 'var(--danger)' : 'var(--line)'}`,
        overflow: 'hidden',
        flex: 'none',
        background: 'var(--faint)',
      }}
      title={error ?? undefined}
    >
      <img
        src={previewUrl}
        alt=""
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: 'block',
          opacity: error ? 0.55 : 0.7,
          filter: error ? 'grayscale(60%)' : 'none',
        }}
      />
      {!error && (
        <span
          aria-label="uploading"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--paper)',
            fontSize: 18,
            textShadow: '0 1px 2px rgba(0,0,0,.45)',
            animation: 'pulse 1.1s ease-in-out infinite',
          }}
        >
          …
        </span>
      )}
      {error && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          aria-label="Dismiss"
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            width: 18,
            height: 18,
            borderRadius: 999,
            background: 'var(--danger)',
            color: 'var(--paper)',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            lineHeight: 1,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

function AddPhotoBtn({
  danger,
  busy,
  onClick,
}: {
  danger?: boolean;
  busy?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      style={{
        width: 56,
        height: 56,
        borderRadius: 8,
        border: `1.5px dashed ${danger ? 'var(--danger)' : 'var(--softline)'}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: danger ? 'var(--danger)' : 'var(--hint)',
        flex: 'none',
        cursor: busy ? 'wait' : 'pointer',
        background: 'var(--paper)',
        padding: 0,
      }}
    >
      {busy ? <span style={{ fontSize: 18 }}>…</span> : <Icon name="plus" />}
    </button>
  );
}

/**
 * Photo thumbnail. Bytes live in Telegram — we ask the backend for a
 * short-lived CDN URL on mount and cache it in TanStack Query so re-renders
 * don't refetch. The owner sees a `×` overlay that triggers backend-side
 * delete (DB row + bot chat message cleanup).
 */
function PhotoThumb({
  photo,
  family,
  canDelete,
  onDelete,
}: {
  photo: PhotoDto;
  family: FamilySummary;
  canDelete?: boolean;
  onDelete?: () => void;
}) {
  const urlQuery = useQuery({
    queryKey: ['photo-url', family.id, photo.id],
    queryFn: () => api.getPhotoUrl(family.id, photo.id),
    // Telegram CDN URLs live ≈ 1h. Cache for slightly less so the link
    // can't go stale while the sheet stays open.
    staleTime: 45 * 60_000,
    gcTime: 60 * 60_000,
  });
  return (
    <div
      style={{
        position: 'relative',
        width: 56,
        height: 56,
        borderRadius: 8,
        border: '1.5px solid var(--line)',
        overflow: 'hidden',
        flex: 'none',
        background: 'var(--faint)',
      }}
    >
      {urlQuery.data ? (
        <img
          src={urlQuery.data.url}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          loading="lazy"
        />
      ) : (
        <div className="wf-stripe" style={{ width: '100%', height: '100%' }} />
      )}
      {canDelete && onDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Delete photo"
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            width: 18,
            height: 18,
            borderRadius: 999,
            background: 'var(--ink)',
            color: 'var(--paper)',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            lineHeight: 1,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

function fmtDeadline(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtCompletedAt(iso: string): string {
  const d = new Date(iso);
  const day = d.getDate();
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${day} ${months[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function describeError(err: ApiError, t: ReturnType<typeof useT>): string {
  const body = err.body as { error?: string } | null;
  if (body?.error === 'photo_required') return t('task.err.photo');
  if (body?.error === 'forbidden') return t('task.err.forbidden');
  return err.message;
}

/**
 * Snooze presets (relative to today). We anchor to *today* rather than to
 * the occurrence's `scheduledDate` because the user is saying "move this
 * forward from where I am right now" — anchoring to the original date
 * would surprise anyone snoozing a past-due task.
 *
 * "До выходных" finds the upcoming Saturday; if today is already Saturday
 * or Sunday, we jump to *next* Saturday so the option still means "later".
 */
function snoozeOptions(
  _currentIso: string | null,
  t: ReturnType<typeof useT>,
): Array<{ key: string; label: string; iso: string }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const addDays = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  // 0 = Sun, 6 = Sat. We want the *next* Saturday; if today already is
  // Sat/Sun, jump a full week forward to next Saturday so the offset is
  // meaningfully "later".
  const dow = today.getDay();
  const daysToNextSaturday = dow === 6 ? 7 : dow === 0 ? 6 : 6 - dow;
  return [
    { key: 'tomorrow', label: t('task.snooze.tomorrow'), iso: addDays(1) },
    { key: 'dayAfter', label: t('task.snooze.dayAfter'), iso: addDays(2) },
    { key: 'weekend', label: t('task.snooze.weekend'), iso: addDays(daysToNextSaturday) },
    { key: '3days', label: t('task.snooze.3days'), iso: addDays(3) },
    { key: 'week', label: t('task.snooze.week'), iso: addDays(7) },
  ];
}

function describeRescheduleError(err: ApiError, t: ReturnType<typeof useT>): string {
  const body = err.body as { error?: string } | null;
  const isEn = t.locale === 'en';
  if (body?.error === 'date_conflict') {
    return isEn
      ? 'Another occurrence of this task is already scheduled for that date.'
      : 'На эту дату уже есть другой повтор этой задачи.';
  }
  if (body?.error === 'already_done') {
    return isEn ? 'Already completed — cannot reschedule.' : 'Уже выполнено — нельзя перенести.';
  }
  if (body?.error === 'wrong_task_type') {
    return isEn ? 'This task type cannot be rescheduled.' : 'Этот тип задачи нельзя перенести.';
  }
  if (body?.error === 'forbidden') return t('task.err.forbidden');
  return err.message;
}

/**
 * Tiny date-picker bottom sheet for the Reschedule action. A native `<input
 * type="date">` keeps the UX consistent with the platform date picker on
 * iOS/Android, and saves us from wiring up a calendar widget.
 */
function ReschedulePicker({
  initialDate,
  onClose,
  onPick,
}: {
  initialDate: string;
  onClose: () => void;
  onPick: (date: string) => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initialDate);
  const isEn = t.locale === 'en';
  // Don't let users reschedule into the past — at minimum, today.
  const todayIso = new Date().toISOString().slice(0, 10);
  return (
    <BottomSheet onClose={onClose} zIndex={14}>
      {({ close }) => (
        <>
          
          <div className="wf-row wf-gap-8" style={{ marginBottom: 8 }}>
            <span className="wf-h2" style={{ flex: 1 }}>
              {isEn ? 'Reschedule' : 'Перенести'}
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
          <span className="wf-hint" style={{ display: 'block', marginBottom: 8 }}>
            {isEn ? 'Pick a new date for this occurrence.' : 'Выбери новую дату для этого повтора.'}
          </span>
          <div className="wf-box" style={{ padding: '8px 10px', marginBottom: 12 }}>
            <input
              type="date"
              value={value}
              min={todayIso}
              onChange={(e) => setValue(e.target.value)}
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
          <div className="wf-row wf-gap-8">
            <button className="wf-btn" onClick={() => close()} style={{ cursor: 'pointer' }}>
              {t('common.cancel')}
            </button>
            <button
              className="wf-btn primary"
              disabled={!value || value === initialDate}
              onClick={() => value && value !== initialDate && close(() => onPick(value))}
              style={{
                flex: 1,
                cursor: value && value !== initialDate ? 'pointer' : 'not-allowed',
                opacity: value && value !== initialDate ? 1 : 0.5,
              }}
            >
              {t('common.save')}
            </button>
          </div>
        </>
      )}
    </BottomSheet>
  );
}

/**
 * Lightweight comments thread under a task. Lazy-fetches on mount;
 * compose + delete-own are wired straight into the api client without
 * optimistic updates (the SSE invalidation arrives faster than a
 * round-trip retry would, so the user sees their message land within
 * a beat without us paying optimistic-rollback complexity).
 */
function CommentsSection({
  me,
  family,
  taskId,
  members,
}: {
  me: MeResponse;
  family: FamilySummary;
  taskId: string;
  members: Member[];
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');

  const commentsQuery = useQuery({
    queryKey: ['task-comments', family.id, taskId],
    queryFn: () => api.listTaskComments(family.id, taskId),
  });
  const addMut = useMutation({
    mutationFn: (text: string) => api.createTaskComment(family.id, taskId, text),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task-comments', family.id, taskId] });
      setDraft('');
    },
  });
  const delMut = useMutation({
    mutationFn: (commentId: string) =>
      api.deleteTaskComment(family.id, taskId, commentId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['task-comments', family.id, taskId] }),
  });

  const comments = commentsQuery.data?.comments ?? [];
  const memberById = new Map(members.map((m) => [m.id, m]));

  return (
    <div className="wf-col" style={{ gap: 6, marginTop: 14 }}>
      <span className="wf-tiny">
        {t('comments.title')}
        {comments.length > 0 && ` · ${comments.length}`}
      </span>
      {comments.map((c) => {
        const author = memberById.get(c.userId);
        const isMine = c.userId === me.id;
        return (
          <div
            key={c.id}
            className="wf-row wf-gap-8"
            style={{ alignItems: 'flex-start' }}
          >
            <Av m={author ?? null} size="xs" />
            <div className="wf-col" style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <span className="wf-tiny" style={{ color: 'var(--hint)' }}>
                {author?.name ?? '—'} ·{' '}
                {new Date(c.createdAt).toLocaleTimeString(
                  t.locale === 'en' ? 'en-US' : 'ru-RU',
                  { hour: '2-digit', minute: '2-digit' },
                )}
              </span>
              <span
                className="wf-label"
                style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
              >
                {c.text}
              </span>
            </div>
            {isMine && (
              <button
                type="button"
                onClick={() => delMut.mutate(c.id)}
                aria-label="delete"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--hint)',
                  cursor: 'pointer',
                  padding: 2,
                  flex: 'none',
                }}
              >
                <Icon name="x" />
              </button>
            )}
          </div>
        );
      })}
      <div className="wf-row wf-gap-6" style={{ marginTop: 4 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
              e.preventDefault();
              addMut.mutate(draft.trim());
            }
          }}
          placeholder={t('comments.placeholder')}
          maxLength={1000}
          className="wf-label"
          style={{
            flex: 1,
            border: '1.5px solid var(--line)',
            borderRadius: 8,
            padding: '6px 10px',
            background: 'var(--paper)',
            outline: 'none',
            color: 'var(--ink)',
            font: 'inherit',
          }}
        />
        <button
          type="button"
          className="wf-btn primary"
          onClick={() => draft.trim() && addMut.mutate(draft.trim())}
          disabled={!draft.trim() || addMut.isPending}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            cursor:
              !draft.trim() || addMut.isPending ? 'default' : 'pointer',
            border: 'none',
          }}
        >
          {t('comments.send')}
        </button>
      </div>
    </div>
  );
}
