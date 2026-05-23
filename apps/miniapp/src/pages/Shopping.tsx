import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type FamilySummary,
  type MeResponse,
  type ShoppingCategory,
  type ShoppingItemDto,
} from '../api';
import { Icon, WfBody } from '../design';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { useT, type TFn } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  /** Shopping is a top-level drawer destination — no in-app back nav
   *  to it. Both back+drawer affordances are routed by FamilyHome. */
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
 * Shared shopping list. One running list per family (auto-seeded on
 * first view). Items group by category for the buyer's aisle-scan;
 * tapping the round box on the left flips status open ↔ bought.
 *
 * Bought items stay visible in a separate collapsible section until
 * the user hits "Архивировать купленное" — they're proof-of-purchase
 * for whoever did the shopping.
 */
export function Shopping({ me, family, onBack, onOpenDrawer }: Props) {
  const t = useT();
  void me;
  const queryClient = useQueryClient();
  const toast = useToast();
  const listQuery = useQuery({
    queryKey: ['shopping', family.id],
    queryFn: () => api.getShoppingList(family.id),
  });
  const items = useMemo(() => listQuery.data?.items ?? [], [listQuery.data]);
  const open = items.filter((i) => i.status === 'open');
  const bought = items.filter((i) => i.status === 'bought');

  const addMut = useMutation({
    mutationFn: (payload: { text: string; category: ShoppingCategory }) =>
      api.addShoppingItem(family.id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shopping', family.id] }),
  });
  const toggleMut = useMutation({
    mutationFn: (input: { id: string; next: 'open' | 'bought' }) =>
      api.updateShoppingItem(family.id, input.id, { status: input.next }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shopping', family.id] }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteShoppingItem(family.id, id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['shopping', family.id] });
      // Toast with Undo — same pattern as task delete. We restore via
      // the dedicated endpoint that flips deletedAt back to null.
      toast.show({
        message: t('common.deleted'),
        variant: 'success',
        durationMs: 5000,
        action: {
          label: t('common.undo'),
          onClick: () => {
            api
              .restoreShoppingItem(family.id, id)
              .then(() =>
                queryClient.invalidateQueries({ queryKey: ['shopping', family.id] }),
              )
              .catch(() =>
                toast.show({ message: t('common.restoreFailed'), variant: 'error' }),
              );
          },
        },
      });
    },
  });
  const archiveMut = useMutation({
    mutationFn: () => api.archiveBoughtShopping(family.id, 0),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shopping', family.id] }),
  });

  // Inline add bar at the bottom — text + category picker. Category
  // defaults to 'other' so the new-item path is one tap (Enter to commit).
  const [text, setText] = useState('');
  const [category, setCategory] = useState<ShoppingCategory>('other');

  // Group OPEN items by category for the aisle-scan layout. Bought items
  // stay flat (chronological) in their own section below.
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

  return (
    <WfBody onBack={onBack}>
      <PageHeader
        title={t('shopping.title')}
        onBack={onBack}
        onOpenDrawer={onOpenDrawer}
        right={
          bought.length > 0 ? (
            <button
              type="button"
              className="wf-btn"
              onClick={() => archiveMut.mutate()}
              disabled={archiveMut.isPending}
              style={{ fontSize: 12, padding: '4px 10px', cursor: 'pointer' }}
            >
              {t('shopping.archive')}
            </button>
          ) : undefined
        }
      />

      {listQuery.isLoading && <span className="wf-hint">{t('common.loading')}</span>}

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
              t={t}
            />
          ))}
        </div>
      ))}

      {bought.length > 0 && (
        <div className="wf-col" style={{ gap: 4, marginTop: 8 }}>
          <span className="wf-tiny">{t('shopping.section.bought')} · {bought.length}</span>
          {bought.map((it) => (
            <ItemRow
              key={it.id}
              item={it}
              onToggle={() => toggleMut.mutate({ id: it.id, next: 'open' })}
              onDelete={() => deleteMut.mutate(it.id)}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Inline add bar — fixed near the bottom (above safe-area). The
          .wf-fab container would be too narrow for a text input, so we
          render a plain row inside .wf-body padding. */}
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
        <div className="wf-row wf-gap-6">
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
            }}
          >
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_EMOJI[c]} {t(`shopping.category.${c}`)}
              </option>
            ))}
          </select>
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
            onClick={commit}
            disabled={!text.trim() || addMut.isPending}
            style={{
              padding: '6px 12px',
              fontSize: 13,
              cursor: !text.trim() || addMut.isPending ? 'default' : 'pointer',
              border: 'none',
            }}
          >
            +
          </button>
        </div>
      </div>
    </WfBody>
  );
}

function ItemRow({
  item,
  onToggle,
  onDelete,
  t,
}: {
  item: ShoppingItemDto;
  onToggle: () => void;
  onDelete: () => void;
  t: TFn;
}) {
  void t;
  const isDone = item.status === 'bought';
  return (
    <div
      className="wf-card"
      style={{
        padding: 8,
        opacity: isDone ? 0.55 : 1,
      }}
    >
      <div className="wf-row wf-gap-8">
        <span
          className={'wf-check' + (isDone ? ' done' : '')}
          onClick={onToggle}
          style={{ cursor: 'pointer', flex: 'none' }}
        >
          {isDone && <Icon name="check" />}
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
          onClick={onDelete}
          aria-label="×"
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
