import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type FamilySummary,
  type MealIngredient,
  type MealPlanEntryDto,
  type MealPlanSlot,
  type MeResponse,
} from '../api';
import { Icon, WfBody } from '../design';
import { BottomSheet } from '../components/BottomSheet';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { interpolate, useT, type TFn } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  onBack?: () => void;
  onOpenDrawer?: () => void;
};

const SLOTS: MealPlanSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];

const SLOT_EMOJI: Record<MealPlanSlot, string> = {
  breakfast: '🥐',
  lunch: '🍱',
  dinner: '🍝',
  snack: '🍎',
  other: '🍽',
};

/**
 * Weekly meal plan page — 7-day grid by slot (breakfast/lunch/dinner/
 * snack). Each cell either shows the planned meal title or a "+" CTA.
 * Tap a cell → editor; editor lets you set title, notes, an ingredient
 * list (one per line) and push those ingredients straight to the
 * family shopping list (the killer feature).
 *
 * Snack is collapsed by default to keep the visual density manageable.
 * Tap "Show snack" to reveal it — TODO once we have a row of meal slots
 * that fills naturally.
 *
 * Week navigation: chevron < / > moves by 7 days. We anchor on Monday
 * for the start-of-week ('cause Russian / EU calendars start Mon).
 */
export function MealPlan({ me, family, onBack, onOpenDrawer }: Props) {
  const t = useT();
  void me;
  const queryClient = useQueryClient();
  const toast = useToast();

  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));

  const fromIso = toIso(weekStart);
  const toIsoStr = toIso(addDays(weekStart, 6));

  const planQuery = useQuery({
    queryKey: ['meal-plan', family.id, fromIso, toIsoStr],
    queryFn: () => api.listMealPlan(family.id, fromIso, toIsoStr),
  });

  const entries = planQuery.data?.entries ?? [];

  // Index by date+slot so the grid can do O(1) lookups while rendering.
  const byKey = useMemo(() => {
    const map = new Map<string, MealPlanEntryDto>();
    for (const e of entries) map.set(`${e.date}|${e.slot}`, e);
    return map;
  }, [entries]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingDate, setEditingDate] = useState<string>('');
  const [editingSlot, setEditingSlot] = useState<MealPlanSlot>('dinner');
  const [editingEntry, setEditingEntry] = useState<MealPlanEntryDto | null>(null);

  const openEditor = (date: string, slot: MealPlanSlot) => {
    setEditingDate(date);
    setEditingSlot(slot);
    setEditingEntry(byKey.get(`${date}|${slot}`) ?? null);
    setEditorOpen(true);
  };

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteMealPlanEntry(family.id, id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['meal-plan', family.id] });
      toast.show({
        message: t('common.deleted'),
        variant: 'success',
        durationMs: 5000,
        action: {
          label: t('common.undo'),
          onClick: () => {
            api
              .restoreMealPlanEntry(family.id, id)
              .then(() =>
                queryClient.invalidateQueries({ queryKey: ['meal-plan', family.id] }),
              )
              .catch(() =>
                toast.show({ message: t('common.restoreFailed'), variant: 'error' }),
              );
          },
        },
      });
    },
  });

  const pushMut = useMutation({
    mutationFn: (id: string) => api.pushMealPlanToShopping(family.id, id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['shopping', family.id] });
      toast.show({
        message: interpolate(t('mealPlan.pushed'), result),
        variant: 'success',
      });
    },
  });

  // Build the 7-day x N-slot grid header + cells. Days are columns in
  // the data sense but render as rows on mobile (one section per day)
  // — narrow screens make a true grid unreadable.
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  return (
    <WfBody onBack={onBack}>
      <PageHeader
        title={t('mealPlan.title')}
        onBack={onBack}
        onOpenDrawer={onOpenDrawer}
      />

      <div className="wf-row wf-gap-6" style={{ alignItems: 'center', marginTop: 4 }}>
        <button
          type="button"
          className="wf-btn"
          onClick={() => setWeekStart((w) => addDays(w, -7))}
          style={{ padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
        >
          <Icon name="chevL" /> {t('mealPlan.weekPrev')}
        </button>
        <span className="wf-tiny" style={{ flex: 1, textAlign: 'center' }}>
          {fmtRange(weekStart, days[6]!)}
        </span>
        <button
          type="button"
          className="wf-btn"
          onClick={() => setWeekStart((w) => addDays(w, 7))}
          style={{ padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
        >
          {t('mealPlan.weekNext')} <Icon name="chevR" />
        </button>
      </div>

      {planQuery.isLoading && <span className="wf-hint">{t('common.loading')}</span>}

      {!planQuery.isLoading && entries.length === 0 && (
        <div className="wf-card subtle" style={{ textAlign: 'center', padding: 18 }}>
          <div style={{ fontSize: 36 }}>🍽</div>
          <span className="wf-h3" style={{ display: 'block', marginTop: 8 }}>
            {t('mealPlan.empty.title')}
          </span>
          <span className="wf-hint" style={{ display: 'block', marginTop: 4 }}>
            {t('mealPlan.empty.hint')}
          </span>
        </div>
      )}

      {days.map((d) => {
        const iso = toIso(d);
        const wkd = t(`mealPlan.wkd.${d.getDay()}`);
        const isToday = iso === toIso(new Date());
        return (
          <div key={iso} className="wf-col" style={{ gap: 4 }}>
            <span
              className="wf-tiny"
              style={{
                marginTop: 6,
                color: isToday ? 'var(--ink)' : 'var(--hint)',
                fontWeight: isToday ? 600 : 400,
              }}
            >
              {wkd} · {d.getDate()}
            </span>
            {SLOTS.map((slot) => {
              const entry = byKey.get(`${iso}|${slot}`) ?? null;
              return (
                <SlotRow
                  key={slot}
                  slot={slot}
                  entry={entry}
                  onOpen={() => openEditor(iso, slot)}
                  onDelete={
                    entry ? () => deleteMut.mutate(entry.id) : undefined
                  }
                  onPush={
                    entry && entry.ingredients.length > 0
                      ? () => pushMut.mutate(entry.id)
                      : undefined
                  }
                  pushPending={pushMut.isPending}
                  t={t}
                />
              );
            })}
          </div>
        );
      })}

      {editorOpen && (
        <MealEntryEditor
          familyId={family.id}
          date={editingDate}
          slot={editingSlot}
          existing={editingEntry}
          onClose={() => setEditorOpen(false)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['meal-plan', family.id] });
            setEditorOpen(false);
          }}
          t={t}
        />
      )}
    </WfBody>
  );
}

function SlotRow({
  slot,
  entry,
  onOpen,
  onDelete,
  onPush,
  pushPending,
  t,
}: {
  slot: MealPlanSlot;
  entry: MealPlanEntryDto | null;
  onOpen: () => void;
  onDelete?: () => void;
  onPush?: () => void;
  pushPending: boolean;
  t: TFn;
}) {
  if (!entry) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="wf-card"
        style={{
          padding: 8,
          textAlign: 'left',
          background: 'var(--faint)',
          border: '1.5px dashed var(--line)',
          cursor: 'pointer',
          color: 'var(--hint)',
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span style={{ fontSize: 16 }}>{SLOT_EMOJI[slot]}</span>
        <span>{t(`mealPlan.slot.${slot}`)}</span>
        <span style={{ marginLeft: 'auto' }}>+</span>
      </button>
    );
  }
  return (
    <div className="wf-card" style={{ padding: 8 }}>
      <div className="wf-row wf-gap-8" style={{ alignItems: 'center' }}>
        <span style={{ fontSize: 18, flex: 'none' }}>{SLOT_EMOJI[slot]}</span>
        <button
          type="button"
          onClick={onOpen}
          style={{
            flex: 1,
            minWidth: 0,
            background: 'transparent',
            border: 'none',
            textAlign: 'left',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <div className="wf-col">
            <span
              className="wf-label"
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {entry.title}
            </span>
            <span className="wf-tiny" style={{ color: 'var(--hint)' }}>
              {t(`mealPlan.slot.${slot}`)}
              {entry.ingredients.length > 0 && ` · ${entry.ingredients.length} ингр.`}
            </span>
          </div>
        </button>
        {onPush && (
          <button
            type="button"
            onClick={onPush}
            disabled={pushPending}
            title={t('mealPlan.pushToShopping')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--hint)',
              cursor: pushPending ? 'default' : 'pointer',
              padding: 4,
              flex: 'none',
            }}
          >
            <Icon name="pkg" />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--hint)',
              cursor: 'pointer',
              padding: 4,
              flex: 'none',
            }}
          >
            <Icon name="x" />
          </button>
        )}
      </div>
    </div>
  );
}

function MealEntryEditor({
  familyId,
  date,
  slot,
  existing,
  onClose,
  onSaved,
  t,
}: {
  familyId: string;
  date: string;
  slot: MealPlanSlot;
  existing: MealPlanEntryDto | null;
  onClose: () => void;
  onSaved: () => void;
  t: TFn;
}) {
  const [title, setTitle] = useState(existing?.title ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  // Ingredient list is edited as a plain textarea (one per line). On save
  // we parse each non-empty line into `{ text }`. Quantity inline in the
  // text is fine for the MVP — the shopping list shows it as-is.
  const [ingText, setIngText] = useState(
    (existing?.ingredients ?? []).map((i) => i.text).join('\n'),
  );

  const parseIngredients = (): MealIngredient[] =>
    ingText
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => ({ text: s }));

  const createMut = useMutation({
    mutationFn: () =>
      api.createMealPlanEntry(familyId, {
        date,
        slot,
        title: title.trim(),
        notes: notes.trim() || null,
        ingredients: parseIngredients(),
      }),
    onSuccess: onSaved,
  });
  const updateMut = useMutation({
    mutationFn: () =>
      api.updateMealPlanEntry(familyId, existing!.id, {
        title: title.trim(),
        notes: notes.trim() || null,
        ingredients: parseIngredients(),
      }),
    onSuccess: onSaved,
  });

  const save = () => {
    if (!title.trim()) return;
    if (existing) updateMut.mutate();
    else createMut.mutate();
  };

  const pending = createMut.isPending || updateMut.isPending;

  return (
    <BottomSheet onClose={onClose}>
      {({ close }) => (
        <>
          <div className="handle" />
          <div className="wf-col" style={{ gap: 10 }}>
            <span className="wf-h3">
              {SLOT_EMOJI[slot]} {t(`mealPlan.slot.${slot}`)} · {date}
            </span>

            <div className="wf-col" style={{ gap: 4 }}>
              <span className="wf-tiny">{t('mealPlan.field.title')}</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
                style={inputStyle}
                autoFocus
              />
            </div>

            <div className="wf-col" style={{ gap: 4 }}>
              <span className="wf-tiny">{t('mealPlan.field.ingredients')}</span>
              <textarea
                value={ingText}
                onChange={(e) => setIngText(e.target.value)}
                placeholder={t('mealPlan.ingredients.placeholder')}
                rows={5}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </div>

            <div className="wf-col" style={{ gap: 4 }}>
              <span className="wf-tiny">{t('mealPlan.field.notes')}</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                maxLength={2000}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </div>

            <div className="wf-row wf-gap-8" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="wf-btn"
                onClick={() => close()}
                style={{ flex: 1, cursor: 'pointer' }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="wf-btn primary"
                disabled={pending || !title.trim()}
                onClick={save}
                style={{
                  flex: 1,
                  cursor: pending || !title.trim() ? 'default' : 'pointer',
                  border: 'none',
                }}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </>
      )}
    </BottomSheet>
  );
}

const inputStyle: React.CSSProperties = {
  border: '1.5px solid var(--line)',
  borderRadius: 8,
  padding: '6px 10px',
  background: 'var(--paper)',
  font: 'inherit',
  color: 'var(--ink)',
  fontSize: 13,
};

// ─── date helpers ──────────────────────────────────────────────────────

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function startOfWeek(d: Date): Date {
  // Monday-anchored. JS getDay(): Sun=0, Mon=1 ... Sat=6.
  const day = d.getDay();
  const back = day === 0 ? 6 : day - 1;
  const out = new Date(d);
  out.setDate(out.getDate() - back);
  out.setHours(0, 0, 0, 0);
  return out;
}

function fmtRange(a: Date, b: Date): string {
  const fmt = (x: Date) =>
    `${String(x.getDate()).padStart(2, '0')}.${String(x.getMonth() + 1).padStart(2, '0')}`;
  return `${fmt(a)} – ${fmt(b)}`;
}
