import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type FamilyMemberDto, type FamilySummary } from '../api';
import { Icon } from '../design';
import { useT } from '../i18n';
import { useToast } from './Toast';

type Props = {
  family: FamilySummary;
  members: FamilyMemberDto[];
};

/**
 * Sticky-note card pinned to the family home (Calendar). One short text
 * blob shared by everyone — "В четверг гости", "Не забыть зарядное".
 *
 * Any member can edit. Empty/whitespace clears the note. On save we
 * stamp `pinnedNoteUpdatedBy` so the UI shows "Maria · 2 ч. назад".
 *
 * Visual: yellow paper card, "📌" leading glyph, footer with editor +
 * relative timestamp. Inline edit on tap; save on Enter (Shift+Enter
 * inserts newline); cancel on Esc.
 */
export function PinnedNote({ family, members }: Props) {
  const t = useT();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(family.pinnedNote ?? '');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Sync draft with server changes when not editing — keeps the textarea
  // ready to open with the latest value next time the user taps edit.
  useEffect(() => {
    if (!editing) setDraft(family.pinnedNote ?? '');
  }, [family.pinnedNote, editing]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      // Place caret at the end of the existing text so editing existing
      // content feels natural (not "select all then type" which clobbers).
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [editing]);

  const updateMut = useMutation({
    mutationFn: (nextValue: string | null) =>
      api.updateFamily(family.id, { pinnedNote: nextValue }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['families'] });
      setEditing(false);
    },
    onError: () => {
      toast.show({ message: t('common.saveFailed') ?? 'Save failed', variant: 'error' });
    },
  });

  const save = () => {
    const trimmed = draft.trim();
    // Sending an empty string would round-trip as "" → null in the service;
    // we pass null explicitly to make the intent obvious in network logs.
    updateMut.mutate(trimmed.length === 0 ? null : trimmed);
  };

  const cancel = () => {
    setDraft(family.pinnedNote ?? '');
    setEditing(false);
  };

  const note = family.pinnedNote;
  const editor =
    family.pinnedNoteUpdatedBy != null
      ? members.find((m) => m.id === family.pinnedNoteUpdatedBy)
      : null;

  // Empty-state pill: small dashed-border card with "+ Pinned note" CTA.
  if (!note && !editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="wf-card"
        style={{
          width: '100%',
          padding: 8,
          textAlign: 'left',
          background: 'var(--faint)',
          border: '1.5px dashed var(--line)',
          cursor: 'pointer',
          color: 'var(--hint)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
        }}
      >
        <Icon name="plus" />
        <span>{t('note.empty.cta')}</span>
      </button>
    );
  }

  if (editing) {
    return (
      <div
        className="wf-card"
        style={{
          padding: 10,
          background: '#FFF8C7',
          border: '1.5px solid #E6D98F',
        }}
      >
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              save();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          placeholder={t('note.placeholder')}
          maxLength={280}
          rows={3}
          style={{
            width: '100%',
            border: 'none',
            background: 'transparent',
            resize: 'none',
            font: 'inherit',
            color: 'var(--ink)',
            outline: 'none',
            padding: 0,
          }}
        />
        <div
          className="wf-row wf-gap-6"
          style={{ marginTop: 8, justifyContent: 'flex-end', alignItems: 'center' }}
        >
          <span className="wf-tiny" style={{ color: 'var(--hint)', flex: 1 }}>
            {draft.length}/280
          </span>
          <button
            type="button"
            className="wf-btn"
            onClick={cancel}
            disabled={updateMut.isPending}
            style={{ fontSize: 12, padding: '4px 10px', cursor: 'pointer' }}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="wf-btn primary"
            onClick={save}
            disabled={updateMut.isPending}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              cursor: updateMut.isPending ? 'default' : 'pointer',
              border: 'none',
            }}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="wf-card"
      onClick={() => setEditing(true)}
      style={{
        padding: 10,
        background: '#FFF8C7',
        border: '1.5px solid #E6D98F',
        cursor: 'pointer',
      }}
    >
      <div className="wf-row wf-gap-8" style={{ alignItems: 'flex-start' }}>
        <span style={{ fontSize: 16, lineHeight: '20px' }}>📌</span>
        <div className="wf-col" style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <span
            className="wf-label"
            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
          >
            {note}
          </span>
          <span className="wf-tiny" style={{ color: 'var(--hint)' }}>
            {editor?.firstName ?? t('note.editor.unknown')}
            {family.pinnedNoteUpdatedAt && ` · ${formatRelative(family.pinnedNoteUpdatedAt)}`}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Tiny "x minutes/hours/days ago" formatter for the pinned-note footer.
 *  Kept inline because no other component currently needs relative time
 *  in this exact shape; promote to a shared util if a 2nd consumer shows up. */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} дн назад`;
  return new Date(iso).toLocaleDateString();
}
