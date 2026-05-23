import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
  type ShoppingCategory,
  type ShoppingItemDto,
  type ShoppingListDto,
} from '../api';
import { Av, Icon, WfBody } from '../design';
import { BottomSheet } from '../components/BottomSheet';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { useT, type TFn } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  /** When set, drill into one list (page state managed by parent so the
   *  hash router can deep-link to it). When null, show list-of-lists. */
  listId: string | null;
  onOpenList: (listId: string) => void;
  onBack?: () => void;
  onOpenDrawer?: () => void;
};

const CATEGORY_ORDER: ShoppingCategory[] = [
  'produce',
  'dairy',
  'meat',
  'bakery',
  'frozen',
  'drinks',
  'household',
  'other',
];

const CATEGORY_EMOJI: Record<ShoppingCategory, string> = {
  dairy: '🥛',
  produce: '🥦',
  meat: '🍗',
  bakery: '🍞',
  household: '🧴',
  drinks: '🥤',
  frozen: '🧊',
  other: '🛒',
};

/**
 * Shopping page — two modes:
 *   1. Index (listId === null): cards for each shopping list with
 *      assignee avatar + due date + item counts. "+" creates a new list.
 *   2. List view (listId set): the running list itself (items grouped
 *      by category), inline add bar at the bottom, "+ Catalog" picker,
 *      and per-item Move/Delete actions.
 */
export function Shopping({
  me,
  family,
  listId,
  onOpenList,
  onBack,
  onOpenDrawer,
}: Props) {
  if (listId === null) {
    return (
      <ShoppingIndex
        me={me}
        family={family}
        onOpenList={onOpenList}
        onBack={onBack}
        onOpenDrawer={onOpenDrawer}
      />
    );
  }
  return (
    <ShoppingListView
      me={me}
      family={family}
      listId={listId}
      onBack={onBack}
    />
  );
}

// ─── INDEX: list-of-lists ──────────────────────────────────────────

function ShoppingIndex({
  me,
  family,
  onOpenList,
  onBack,
  onOpenDrawer,
}: {
  me: MeResponse;
  family: FamilySummary;
  onOpenList: (id: string) => void;
  onBack?: () => void;
  onOpenDrawer?: () => void;
}) {
  const t = useT();
  void me;
  const listsQuery = useQuery({
    queryKey: ['shopping', family.id],
    queryFn: () => api.listShoppingLists(family.id),
  });
  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });
  const members = membersQuery.data?.members ?? [];
  const memberById = useMemo(
    () => new Map(members.map((m) => [m.id, m])),
    [members],
  );
  const lists = listsQuery.data?.lists ?? [];
  const [editorOpen, setEditorOpen] = useState(false);

  return (
    <WfBody onBack={onBack}>
      <PageHeader
        title={t('shopping.title')}
        onBack={onBack}
        onOpenDrawer={onOpenDrawer}
        right={
          <button
            type="button"
            className="wf-btn primary"
            onClick={() => setEditorOpen(true)}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              cursor: 'pointer',
              border: 'none',
            }}
          >
            + {t('shopping.list.create')}
          </button>
        }
      />

      {listsQuery.isLoading && <span className="wf-hint">{t('common.loading')}</span>}

      {!listsQuery.isLoading && lists.length === 0 && (
        <div className="wf-card subtle" style={{ textAlign: 'center', padding: 18 }}>
          <div style={{ fontSize: 36 }}>🛒</div>
          <span className="wf-h3" style={{ display: 'block', marginTop: 8 }}>
            {t('shopping.index.empty.title')}
          </span>
          <span className="wf-hint" style={{ display: 'block', marginTop: 4 }}>
            {t('shopping.index.empty.hint')}
          </span>
        </div>
      )}

      {lists.map((l) => (
        <ListCard
          key={l.id}
          list={l}
          assignee={l.assigneeUserId ? memberById.get(l.assigneeUserId) : undefined}
          onClick={() => onOpenList(l.id)}
          t={t}
        />
      ))}

      {editorOpen && (
        <ListEditor
          family={family}
          members={members}
          existing={null}
          onClose={() => setEditorOpen(false)}
          onSaved={(created) => {
            setEditorOpen(false);
            onOpenList(created.id);
          }}
          t={t}
        />
      )}
    </WfBody>
  );
}

function ListCard({
  list,
  assignee,
  onClick,
  t,
}: {
  list: ShoppingListDto;
  assignee: FamilyMemberDto | undefined;
  onClick: () => void;
  t: TFn;
}) {
  const total = (list.openCount ?? 0) + (list.boughtCount ?? 0);
  const tint = assignee?.color ?? 'var(--faint)';
  return (
    <div
      className="wf-card"
      onClick={onClick}
      style={{ padding: 10, cursor: 'pointer' }}
    >
      <div className="wf-row wf-gap-10" style={{ alignItems: 'center' }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            background: tint,
            border: '1.5px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 20,
            flex: 'none',
          }}
        >
          🛒
        </div>
        <div className="wf-col" style={{ flex: 1, minWidth: 0 }}>
          <span
            className="wf-label"
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {list.name}
          </span>
          <span className="wf-tiny" style={{ color: 'var(--hint)' }}>
            {assignee?.firstName ?? t('shopping.list.unassigned')}
            {list.dueDate ? ` · ${list.dueDate}` : ''}
            {total > 0
              ? ` · ${list.boughtCount ?? 0}/${total}`
              : ''}
          </span>
        </div>
        <Icon name="chevR" />
      </div>
    </div>
  );
}

// ─── LIST VIEW: items of one list ──────────────────────────────────

function ShoppingListView({
  me,
  family,
  listId,
  onBack,
}: {
  me: MeResponse;
  family: FamilySummary;
  listId: string;
  onBack?: () => void;
}) {
  const t = useT();
  void me;
  const queryClient = useQueryClient();
  const toast = useToast();
  const listQuery = useQuery({
    queryKey: ['shopping', family.id, listId],
    queryFn: () => api.getShoppingList(family.id, listId),
  });
  const allListsQuery = useQuery({
    queryKey: ['shopping', family.id],
    queryFn: () => api.listShoppingLists(family.id),
  });
  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });
  const list = listQuery.data?.list ?? null;
  const items = useMemo(() => listQuery.data?.items ?? [], [listQuery.data]);
  const members = membersQuery.data?.members ?? [];
  const open = items.filter((i) => i.status === 'open');
  const bought = items.filter((i) => i.status === 'bought');

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['shopping', family.id] });
  };
  const addMut = useMutation({
    mutationFn: (payload: { text: string; category: ShoppingCategory }) =>
      api.addShoppingItem(family.id, listId, payload),
    onSuccess: invalidate,
  });
  const toggleMut = useMutation({
    mutationFn: (input: { id: string; next: 'open' | 'bought' }) =>
      api.updateShoppingItem(family.id, input.id, { status: input.next }),
    onSuccess: invalidate,
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteShoppingItem(family.id, id),
    onSuccess: (_data, id) => {
      invalidate();
      toast.show({
        message: t('common.deleted'),
        variant: 'success',
        durationMs: 5000,
        action: {
          label: t('common.undo'),
          onClick: () => {
            api
              .restoreShoppingItem(family.id, id)
              .then(invalidate)
              .catch(() =>
                toast.show({ message: t('common.restoreFailed'), variant: 'error' }),
              );
          },
        },
      });
    },
  });
  const archiveMut = useMutation({
    mutationFn: () => api.archiveBoughtShopping(family.id, listId, 0),
    onSuccess: invalidate,
  });
  const moveMut = useMutation({
    mutationFn: (input: { itemId: string; targetListId: string }) =>
      api.moveShoppingItem(family.id, input.itemId, input.targetListId),
    onSuccess: invalidate,
  });
  const addCatalogMut = useMutation({
    mutationFn: (catalogItemIds: string[]) =>
      api.addCatalogItemsToShoppingList(family.id, listId, catalogItemIds),
    onSuccess: (res) => {
      invalidate();
      toast.show({
        message: `${t('shopping.added')} ${res.added.length} · ${t('shopping.skipped')} ${res.skipped}`,
        variant: 'success',
      });
    },
  });

  const [text, setText] = useState('');
  const [category, setCategory] = useState<ShoppingCategory>('other');
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<ShoppingItemDto | null>(null);
  const [listEditorOpen, setListEditorOpen] = useState(false);

  const grouped = useMemo(() => {
    const map = new Map<ShoppingCategory, ShoppingItemDto[]>();
    for (const it of open) {
      const arr = map.get(it.category) ?? [];
      arr.push(it);
      map.set(it.category, arr);
    }
    return CATEGORY_ORDER.filter((c) => map.has(c)).map((c) => ({
      category: c,
      items: map.get(c)!,
    }));
  }, [open]);

  const commit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    addMut.mutate({ text: trimmed, category });
    setText('');
  };

  const memberById = new Map(members.map((m) => [m.id, m]));
  const assignee = list?.assigneeUserId ? memberById.get(list.assigneeUserId) : null;

  return (
    <WfBody onBack={onBack}>
      <PageHeader
        title={list?.name ?? t('shopping.title')}
        subtitle={
          list
            ? `${assignee?.firstName ?? t('shopping.list.unassigned')}${
                list.dueDate ? ` · ${list.dueDate}` : ''
              }`
            : undefined
        }
        onBack={onBack}
        right={
          <div className="wf-row wf-gap-6">
            <button
              type="button"
              className="wf-btn"
              onClick={() => setListEditorOpen(true)}
              style={{ fontSize: 12, padding: '4px 10px', cursor: 'pointer' }}
            >
              <Icon name="edit" />
            </button>
            {bought.length > 0 && (
              <button
                type="button"
                className="wf-btn"
                onClick={() => archiveMut.mutate()}
                disabled={archiveMut.isPending}
                style={{ fontSize: 12, padding: '4px 10px', cursor: 'pointer' }}
              >
                {t('shopping.archive')}
              </button>
            )}
          </div>
        }
      />

      {listQuery.isLoading && <span className="wf-hint">{t('common.loading')}</span>}

      <button
        type="button"
        className="wf-btn"
        onClick={() => setCatalogOpen(true)}
        style={{
          fontSize: 12,
          padding: '6px 10px',
          cursor: 'pointer',
          alignSelf: 'flex-start',
        }}
      >
        + {t('shopping.fromCatalog')}
      </button>

      {!listQuery.isLoading && items.length === 0 && (
        <div className="wf-card subtle" style={{ textAlign: 'center', padding: 18 }}>
          <div style={{ fontSize: 36 }}>🛒</div>
          <span className="wf-h3" style={{ display: 'block', marginTop: 8 }}>
            {t('shopping.empty.title')}
          </span>
          <span className="wf-hint" style={{ display: 'block', marginTop: 4 }}>
            {t('shopping.empty.hint')}
          </span>
        </div>
      )}

      {grouped.map(({ category: cat, items: catItems }) => (
        <div key={cat} className="wf-col" style={{ gap: 4 }}>
          <span className="wf-tiny" style={{ marginTop: 4 }}>
            {CATEGORY_EMOJI[cat]} {t(`shopping.category.${cat}`)}
          </span>
          {catItems.map((it) => (
            <ItemRow
              key={it.id}
              item={it}
              onToggle={() => toggleMut.mutate({ id: it.id, next: 'bought' })}
              onDelete={() => deleteMut.mutate(it.id)}
              onMove={() => setMoveTarget(it)}
            />
          ))}
        </div>
      ))}

      {bought.length > 0 && (
        <div className="wf-col" style={{ gap: 4, marginTop: 8 }}>
          <span className="wf-tiny">
            {t('shopping.section.bought')} · {bought.length}
          </span>
          {bought.map((it) => (
            <ItemRow
              key={it.id}
              item={it}
              onToggle={() => toggleMut.mutate({ id: it.id, next: 'open' })}
              onDelete={() => deleteMut.mutate(it.id)}
              onMove={() => setMoveTarget(it)}
            />
          ))}
        </div>
      )}

      {/* Inline add bar */}
      <div
        className="wf-card"
        style={{
          position: 'sticky',
          bottom: 0,
          marginTop: 8,
          padding: 8,
          background: 'var(--paper)',
        }}
      >
        {/* Two-row layout: row 1 = name input (full width), row 2 =
            category picker + add button. The previous single-row layout
            squashed the dropdown's emoji+label and gave the name input
            barely any space on narrow screens. */}
        <div className="wf-col wf-gap-6" style={{ minWidth: 0 }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              }
            }}
            placeholder={t('shopping.add.placeholder')}
            className="wf-label"
            style={{
              width: '100%',
              minWidth: 0,
              border: '1.5px solid var(--line)',
              borderRadius: 8,
              padding: '6px 10px',
              background: 'var(--paper)',
              outline: 'none',
              color: 'var(--ink)',
              font: 'inherit',
            }}
          />
          <div className="wf-row wf-gap-6" style={{ minWidth: 0 }}>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ShoppingCategory)}
              style={{
                border: '1.5px solid var(--line)',
                borderRadius: 8,
                padding: '6px 8px',
                background: 'var(--paper)',
                font: 'inherit',
                fontSize: 13,
                flex: 1,
                minWidth: 0,
              }}
            >
              {CATEGORY_ORDER.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_EMOJI[c]} {t(`shopping.category.${c}`)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="wf-btn primary"
              onClick={commit}
              disabled={!text.trim() || addMut.isPending}
              style={{
                padding: '6px 16px',
                fontSize: 13,
                cursor: !text.trim() || addMut.isPending ? 'default' : 'pointer',
                border: 'none',
                flex: 'none',
              }}
            >
              +
            </button>
          </div>
        </div>
      </div>

      {catalogOpen && (
        <CatalogPicker
          familyId={family.id}
          onClose={() => setCatalogOpen(false)}
          onPick={(ids) => {
            addCatalogMut.mutate(ids);
            setCatalogOpen(false);
          }}
          t={t}
        />
      )}

      {moveTarget && (
        <MoveToPicker
          family={family}
          members={members}
          item={moveTarget}
          allLists={(allListsQuery.data?.lists ?? []).filter((l) => l.id !== listId)}
          onClose={() => setMoveTarget(null)}
          onPick={(targetListId) => {
            moveMut.mutate({ itemId: moveTarget.id, targetListId });
            setMoveTarget(null);
          }}
          t={t}
        />
      )}

      {listEditorOpen && list && (
        <ListEditor
          family={family}
          members={members}
          existing={list}
          onClose={() => setListEditorOpen(false)}
          onSaved={() => {
            setListEditorOpen(false);
            invalidate();
          }}
          onArchived={() => {
            setListEditorOpen(false);
            invalidate();
            onBack?.();
          }}
          t={t}
        />
      )}
    </WfBody>
  );
}

function ItemRow({
  item,
  onToggle,
  onDelete,
  onMove,
}: {
  item: ShoppingItemDto;
  onToggle: () => void;
  onDelete: () => void;
  onMove: () => void;
}) {
  const isDone = item.status === 'bought';
  // Each item carries a category — pick the matching emoji so the list
  // is visually scannable. User report: "В списке покупок не показывает
  // иконку". The same CATEGORY_EMOJI map is already used in the
  // dropdown above; reusing it here keeps icons consistent.
  const categoryIcon = CATEGORY_EMOJI[item.category as ShoppingCategory] ?? '🛒';
  return (
    <div className="wf-card" style={{ padding: 8, opacity: isDone ? 0.55 : 1 }}>
      <div className="wf-row wf-gap-8">
        <span
          className={'wf-check' + (isDone ? ' done' : '')}
          onClick={onToggle}
          style={{ cursor: 'pointer', flex: 'none' }}
        >
          {isDone && <Icon name="check" />}
        </span>
        <span
          aria-hidden
          style={{
            fontSize: 18,
            lineHeight: 1,
            flex: 'none',
            opacity: isDone ? 0.5 : 1,
          }}
        >
          {categoryIcon}
        </span>
        <div className="wf-col" style={{ flex: 1, minWidth: 0 }}>
          <span
            className="wf-label"
            style={
              isDone
                ? { textDecoration: 'line-through', color: 'var(--hint)' }
                : undefined
            }
          >
            {item.text}
            {item.quantity ? (
              <span className="wf-tiny" style={{ marginLeft: 6, color: 'var(--hint)' }}>
                {item.quantity}
              </span>
            ) : null}
          </span>
        </div>
        <button
          type="button"
          onClick={onMove}
          aria-label="move"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--hint)',
            cursor: 'pointer',
            padding: 4,
          }}
        >
          <Icon name="more" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label="delete"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--hint)',
            cursor: 'pointer',
            padding: 4,
          }}
        >
          <Icon name="x" />
        </button>
      </div>
    </div>
  );
}

// ─── editors / pickers ─────────────────────────────────────────────

function ListEditor({
  family,
  members,
  existing,
  onClose,
  onSaved,
  onArchived,
  t,
}: {
  family: FamilySummary;
  members: FamilyMemberDto[];
  existing: ShoppingListDto | null;
  onClose: () => void;
  onSaved: (list: ShoppingListDto) => void;
  onArchived?: () => void;
  t: TFn;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [assigneeUserId, setAssigneeUserId] = useState<string | null>(
    existing?.assigneeUserId ?? null,
  );
  const [dueDate, setDueDate] = useState<string | null>(existing?.dueDate ?? null);

  const createMut = useMutation({
    mutationFn: () =>
      api.createShoppingList(family.id, {
        name: name.trim(),
        assigneeUserId,
        dueDate,
      }),
    onSuccess: (res) => onSaved(res.list),
  });
  const updateMut = useMutation({
    mutationFn: () =>
      api.updateShoppingList(family.id, existing!.id, {
        name: name.trim(),
        assigneeUserId,
        dueDate,
      }),
    onSuccess: (res) => onSaved(res.list),
  });
  const archiveMut = useMutation({
    mutationFn: () => api.archiveShoppingList(family.id, existing!.id),
    onSuccess: () => onArchived?.(),
  });

  const pending = createMut.isPending || updateMut.isPending || archiveMut.isPending;
  const save = () => {
    if (!name.trim()) return;
    if (existing) updateMut.mutate();
    else createMut.mutate();
  };

  return (
    <BottomSheet onClose={onClose}>
      {({ close }) => (
        <>
          <div className="handle" />
          <div className="wf-col" style={{ gap: 10 }}>
            <span className="wf-h3">
              {existing ? t('shopping.list.edit') : t('shopping.list.create')}
            </span>

            <Field label={t('shopping.field.name')}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                style={inputStyle}
                autoFocus
              />
            </Field>

            <Field label={t('shopping.field.assignee')}>
              <select
                value={assigneeUserId ?? ''}
                onChange={(e) => setAssigneeUserId(e.target.value || null)}
                style={inputStyle}
              >
                <option value="">{t('shopping.list.unassigned')}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.firstName}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={t('shopping.field.dueDate')}>
              <input
                type="date"
                value={dueDate ?? ''}
                onChange={(e) => setDueDate(e.target.value || null)}
                style={{ ...inputStyle, maxWidth: 200 }}
              />
            </Field>

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
                onClick={save}
                disabled={pending || !name.trim()}
                style={{
                  flex: 1,
                  cursor: pending || !name.trim() ? 'default' : 'pointer',
                  border: 'none',
                }}
              >
                {t('common.save')}
              </button>
            </div>
            {existing && onArchived && (
              <button
                type="button"
                className="wf-btn"
                onClick={() => archiveMut.mutate()}
                disabled={pending}
                style={{
                  cursor: pending ? 'default' : 'pointer',
                  color: '#d33',
                  marginTop: 4,
                }}
              >
                {t('shopping.list.archive')}
              </button>
            )}
          </div>
        </>
      )}
    </BottomSheet>
  );
}

function CatalogPicker({
  familyId,
  onClose,
  onPick,
  t,
}: {
  familyId: string;
  onClose: () => void;
  onPick: (catalogItemIds: string[]) => void;
  t: TFn;
}) {
  const [q, setQ] = useState('');
  const catalogQuery = useQuery({
    queryKey: ['catalog', familyId, q],
    queryFn: () => api.listCatalog(familyId, q || undefined),
  });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const items = catalogQuery.data?.items ?? [];

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <BottomSheet onClose={onClose}>
      {({ close }) => (
        <>
          <div className="handle" />
          <div className="wf-col" style={{ gap: 10 }}>
            <span className="wf-h3">{t('shopping.catalogPicker.title')}</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('shopping.catalogPicker.search')}
              style={inputStyle}
            />
            <div
              className="wf-col"
              style={{ gap: 4, maxHeight: '50vh', overflowY: 'auto' }}
            >
              {items.length === 0 ? (
                <span className="wf-hint" style={{ textAlign: 'center', padding: 8 }}>
                  {t('shopping.catalogPicker.empty')}
                </span>
              ) : (
                items.map((it) => {
                  const selected = picked.has(it.id);
                  return (
                    <div
                      key={it.id}
                      className="wf-card"
                      onClick={() => toggle(it.id)}
                      style={{
                        padding: 8,
                        cursor: 'pointer',
                        ...(selected
                          ? { outline: '2px solid var(--ink)', outlineOffset: -2 }
                          : null),
                      }}
                    >
                      <div className="wf-row wf-gap-8">
                        <span
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: 4,
                            border: '1.5px solid var(--ink)',
                            background: selected ? 'var(--ink)' : 'transparent',
                            color: 'var(--paper)',
                            fontSize: 11,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flex: 'none',
                          }}
                        >
                          {selected ? '✓' : ''}
                        </span>
                        <span className="wf-label" style={{ flex: 1 }}>
                          {it.emoji ? `${it.emoji} ` : ''}{it.name}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
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
                onClick={() => onPick(Array.from(picked))}
                disabled={picked.size === 0}
                style={{
                  flex: 1,
                  cursor: picked.size === 0 ? 'default' : 'pointer',
                  border: 'none',
                }}
              >
                {t('shopping.catalogPicker.add')} ({picked.size})
              </button>
            </div>
          </div>
        </>
      )}
    </BottomSheet>
  );
}

function MoveToPicker({
  family,
  members,
  item,
  allLists,
  onClose,
  onPick,
  t,
}: {
  family: FamilySummary;
  members: FamilyMemberDto[];
  item: ShoppingItemDto;
  allLists: ShoppingListDto[];
  onClose: () => void;
  onPick: (targetListId: string) => void;
  t: TFn;
}) {
  const [createNewOpen, setCreateNewOpen] = useState(false);
  void item;
  if (createNewOpen) {
    return (
      <ListEditor
        family={family}
        members={members}
        existing={null}
        onClose={() => setCreateNewOpen(false)}
        onSaved={(created) => {
          setCreateNewOpen(false);
          onPick(created.id);
        }}
        t={t}
      />
    );
  }
  return (
    <BottomSheet onClose={onClose}>
      {({ close }) => (
        <>
          <div className="handle" />
          <div className="wf-col" style={{ gap: 6 }}>
            <span className="wf-h3">{t('shopping.moveTo.title')}</span>
            {allLists.length === 0 && (
              <span className="wf-hint" style={{ padding: 4 }}>
                {t('shopping.moveTo.noOthers')}
              </span>
            )}
            {allLists.map((l) => {
              const a = l.assigneeUserId
                ? members.find((m) => m.id === l.assigneeUserId)
                : null;
              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => onPick(l.id)}
                  className="wf-card"
                  style={{
                    padding: 8,
                    textAlign: 'left',
                    cursor: 'pointer',
                    background: 'var(--paper)',
                    border: '1.5px solid var(--line)',
                  }}
                >
                  <div className="wf-row wf-gap-8" style={{ alignItems: 'center' }}>
                    <Av
                      m={
                        a
                          ? {
                              id: a.id,
                              name: a.firstName,
                              letter: a.firstName[0]!,
                              color: a.color,
                              role: a.role.name,
                            }
                          : null
                      }
                      size="sm"
                    />
                    <span className="wf-label" style={{ flex: 1 }}>
                      {l.name}
                    </span>
                    <Icon name="chevR" />
                  </div>
                </button>
              );
            })}
            <button
              type="button"
              className="wf-btn"
              onClick={() => setCreateNewOpen(true)}
              style={{ marginTop: 4, cursor: 'pointer' }}
            >
              + {t('shopping.moveTo.newList')}
            </button>
            <button
              type="button"
              className="wf-btn"
              onClick={() => close()}
              style={{ marginTop: 4, cursor: 'pointer' }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </>
      )}
    </BottomSheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="wf-col" style={{ gap: 4 }}>
      <span className="wf-tiny">{label}</span>
      {children}
    </div>
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
