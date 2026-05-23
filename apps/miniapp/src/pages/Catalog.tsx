import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CatalogItemDto, type FamilySummary, type MeResponse } from '../api';
import { Icon, Tag, WfBody } from '../design';
import { PageHeader } from '../components/PageHeader';
import { useT, type TFn } from '../i18n';

/** Catalog categories the backend assigns when items get auto-promoted
 *  from a shopping list. The set mirrors `ShoppingCategory` so chips can
 *  resolve to the existing shopping.category.* i18n keys. Anything not
 *  in this list falls back to its raw string (user-typed categories or
 *  legacy values without translations). */
const KNOWN_CATEGORIES = [
  'dairy',
  'produce',
  'meat',
  'bakery',
  'household',
  'drinks',
  'frozen',
  'other',
] as const;

function translateCategory(raw: string, t: TFn): string {
  if ((KNOWN_CATEGORIES as readonly string[]).includes(raw)) {
    return t(`shopping.category.${raw}`);
  }
  return raw;
}

type Props = {
  me: MeResponse;
  family: FamilySummary;
  /** Back when reached via in-app nav. */
  onBack?: () => void;
  /** Burger when reached via the drawer. */
  onOpenDrawer?: () => void;
};

const PRESET_EMOJI = [
  '🥖',
  '🥛',
  '🥚',
  '🧀',
  '🍞',
  '🍎',
  '🥕',
  '🍌',
  '🍅',
  '🍫',
  '🧴',
  '🧻',
  '🧽',
  '🥫',
  '🍝',
  '🐟',
];

const ALL = '__all__';

/** Port of CatV1 (screens-roles-catalog.jsx :174-233). */
export function Catalog({ me, family, onBack, onOpenDrawer }: Props) {
  void me;
  const queryClient = useQueryClient();
  const t = useT();
  const OTHER = t('catalog.category.other');
  const [query, setQuery] = useState('');
  const [activeCat, setActiveCat] = useState<string>(ALL);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmoji, setNewEmoji] = useState<string>(PRESET_EMOJI[0]!);
  // Tap a card → opens this editor. Backend supports name/emoji/category
  // via PATCH /catalog/:id; we expose all three.
  const [editing, setEditing] = useState<CatalogItemDto | null>(null);

  const listQuery = useQuery({
    queryKey: ['catalog', family.id, query],
    queryFn: () => api.listCatalog(family.id, query || undefined),
  });

  const items = listQuery.data?.items ?? [];

  // Category counts
  const catCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const it of items) {
      const cat = it.category ?? OTHER;
      map.set(cat, (map.get(cat) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [items]);

  const visible = useMemo(() => {
    if (activeCat === ALL) return items;
    return items.filter((it) => (it.category ?? OTHER) === activeCat);
  }, [items, activeCat]);

  const createMut = useMutation({
    mutationFn: () =>
      api.createCatalogItem(family.id, {
        name: newName.trim(),
        emoji: newEmoji,
      }),
    onSuccess: () => {
      setNewName('');
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ['catalog', family.id] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (itemId: string) => api.deleteCatalogItem(family.id, itemId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['catalog', family.id] }),
  });

  const updateMut = useMutation({
    mutationFn: (payload: {
      id: string;
      name: string;
      emoji: string;
      category: string | null;
    }) =>
      api.updateCatalogItem(family.id, payload.id, {
        name: payload.name,
        emoji: payload.emoji,
        category: payload.category,
      }),
    onSuccess: () => {
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ['catalog', family.id] });
    },
  });

  return (
    <WfBody onBack={onBack}>
      <PageHeader
        title={t('catalog.title')}
        onBack={onBack}
        onOpenDrawer={onOpenDrawer}
        right={
          <button
            onClick={() => setCreating(true)}
            aria-label={t('common.add')}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--ink)' }}
          >
            <Icon name="plus" />
          </button>
        }
      />

      {/* Search */}
      <div className="wf-box" style={{ padding: '8px 10px' }}>
        <div className="wf-row wf-gap-6">
          <Icon name="search" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('catalog.search.placeholder')}
            className="wf-label"
            style={{
              flex: 1,
              border: 'none',
              background: 'transparent',
              outline: 'none',
              color: 'var(--ink)',
              font: 'inherit',
            }}
          />
        </div>
      </div>

      {/* Category chips */}
      {catCounts.length > 0 && (
        <div className="wf-row wf-gap-6" style={{ flexWrap: 'wrap' }}>
          <span
            onClick={() => setActiveCat(ALL)}
            className={'wf-tag' + (activeCat === ALL ? ' solid' : '')}
            style={{ cursor: 'pointer', userSelect: 'none' }}
          >
            {t('catalog.chip.all')} · {items.length}
          </span>
          {catCounts.map(([cat, count]) => (
            <span
              key={cat}
              onClick={() => setActiveCat(cat)}
              className={'wf-tag' + (activeCat === cat ? ' solid' : '')}
              style={{ cursor: 'pointer', userSelect: 'none' }}
            >
              {translateCategory(cat, t)} · {count}
            </span>
          ))}
        </div>
      )}

      {creating && (
        <div className="wf-card">
          <span className="wf-tiny">{t('catalog.new')}</span>
          <div className="wf-row wf-gap-6" style={{ marginTop: 6 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 999,
                background: 'var(--faint)',
                border: '1.5px solid var(--line)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 20,
              }}
            >
              {newEmoji}
            </div>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('catalog.new.placeholder')}
              autoFocus
              className="wf-label"
              style={{
                flex: 1,
                border: 'none',
                background: 'transparent',
                outline: 'none',
                color: 'var(--ink)',
                font: 'inherit',
                padding: '8px 0',
              }}
              maxLength={100}
            />
          </div>
          <div
            style={{
              marginTop: 8,
              display: 'grid',
              gridTemplateColumns: 'repeat(8, 1fr)',
              gap: 4,
            }}
          >
            {PRESET_EMOJI.map((e) => (
              <button
                key={e}
                onClick={() => setNewEmoji(e)}
                style={{
                  background: e === newEmoji ? 'var(--ink)' : 'var(--paper)',
                  border: '1.5px solid var(--line)',
                  borderRadius: 8,
                  fontSize: 18,
                  padding: 4,
                  aspectRatio: '1',
                  cursor: 'pointer',
                }}
              >
                {e}
              </button>
            ))}
          </div>
          <div className="wf-row wf-gap-8" style={{ marginTop: 10 }}>
            <button className="wf-btn" onClick={() => setCreating(false)} style={{ cursor: 'pointer' }}>
              {t('common.cancel')}
            </button>
            <button
              className="wf-btn primary"
              onClick={() => createMut.mutate()}
              disabled={!newName.trim() || createMut.isPending}
              style={{
                flex: 1,
                cursor: !newName.trim() || createMut.isPending ? 'default' : 'pointer',
                opacity: !newName.trim() || createMut.isPending ? 0.5 : 1,
              }}
            >
              {createMut.isPending ? t('common.saving') : t('common.add')}
            </button>
          </div>
        </div>
      )}

      {listQuery.isLoading && <span className="wf-hint">{t('common.loading')}</span>}

      {!listQuery.isLoading && items.length === 0 && !creating && (
        <div
          className="wf-body"
          style={{ alignItems: 'center', textAlign: 'center', padding: 0 }}
        >
          <div style={{ fontSize: 48, marginTop: 24 }}>🛒</div>
          <span className="wf-h2" style={{ marginTop: 8 }}>
            {t('catalog.empty.title')}
          </span>
          <span className="wf-hint" style={{ marginTop: 6, maxWidth: 280 }}>
            {t('catalog.empty.hint')}
          </span>
          <button
            className="wf-btn primary lg block"
            onClick={() => setCreating(true)}
            style={{ marginTop: 16, cursor: 'pointer' }}
          >
            {t('catalog.empty.cta')}
          </button>
        </div>
      )}

      {/* Grid */}
      {visible.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {visible.map((it) => (
            <CatalogCard
              key={it.id}
              it={it}
              onEdit={() => setEditing(it)}
              onDelete={() => {
                if (confirm(t('catalog.confirm.delete.item', { name: it.name })))
                  deleteMut.mutate(it.id);
              }}
            />
          ))}
        </div>
      )}

      {/* Edit modal — name / emoji / category. Submits via PATCH. */}
      {editing && (
        <CatalogEditModal
          item={editing}
          presetEmoji={PRESET_EMOJI}
          presetCategories={KNOWN_CATEGORIES}
          translateCategory={(c) => translateCategory(c, t)}
          pending={updateMut.isPending}
          onClose={() => setEditing(null)}
          onSave={(payload) => updateMut.mutate({ id: editing.id, ...payload })}
          t={t}
        />
      )}

      {/* Auto-grow info */}
      {!listQuery.isLoading && items.length > 0 && (
        <div className="wf-card subtle">
          <div className="wf-row wf-gap-6">
            <span aria-hidden="true" style={{ fontSize: 14 }}>ℹ️</span>
            <span className="wf-tiny">
              {t('catalog.grow.hint')}
            </span>
          </div>
        </div>
      )}

      {!listQuery.isLoading && items.length > 0 && activeCat !== ALL && (
        <Tag>
          {t('catalog.inCategory', {
            n: visible.length,
            cat: translateCategory(activeCat, t),
          })}
        </Tag>
      )}
    </WfBody>
  );
}

function CatalogCard({
  it,
  onEdit,
  onDelete,
}: {
  it: CatalogItemDto;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const freq = frequencyLabel(it.usageCount, t);
  const price = formatPrice(it.lastPriceCents, it.lastCurrency);
  return (
    <div
      className="wf-card"
      style={{ padding: 10, position: 'relative', cursor: 'pointer' }}
      onClick={onEdit}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit();
        }
      }}
    >
      <div className="wf-row wf-gap-8">
        <span style={{ fontSize: 24 }}>{it.emoji ?? '📦'}</span>
        <div className="wf-col" style={{ flex: 1, minWidth: 0 }}>
          <span
            className="wf-label"
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {it.name}
          </span>
          <span className="wf-tiny">{freq}</span>
        </div>
      </div>
      <div className="wf-spread" style={{ marginTop: 6 }}>
        <span className="wf-tiny wf-mono">{price ?? '—'}</span>
        {it.usageCount === 0 && (
          <button
            // Stop the row's onClick so deleting doesn't also open the
            // editor underneath.
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            aria-label={t('common.delete')}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              color: 'var(--hint)',
              fontSize: 12,
            }}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

function CatalogEditModal({
  item,
  presetEmoji,
  presetCategories,
  translateCategory,
  pending,
  onClose,
  onSave,
  t,
}: {
  item: CatalogItemDto;
  presetEmoji: readonly string[];
  presetCategories: readonly string[];
  translateCategory: (raw: string) => string;
  pending: boolean;
  onClose: () => void;
  onSave: (payload: { name: string; emoji: string; category: string | null }) => void;
  t: TFn;
}) {
  const [name, setName] = useState(item.name);
  const [emoji, setEmoji] = useState<string>(item.emoji ?? '📦');
  const [category, setCategory] = useState<string | null>(item.category ?? null);
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="wf-card"
        style={{
          width: '100%',
          maxWidth: 480,
          margin: 0,
          borderRadius: '12px 12px 0 0',
          padding: 16,
          background: 'var(--paper)',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <span className="wf-h3">{t('catalog.edit.title')}</span>
        <div className="wf-row wf-gap-6" style={{ marginTop: 10 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 999,
              background: 'var(--faint)',
              border: '1.5px solid var(--line)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 22,
              flex: 'none',
            }}
          >
            {emoji}
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="wf-label"
            style={{
              flex: 1,
              border: '1.5px solid var(--line)',
              borderRadius: 8,
              padding: '8px 10px',
              background: 'var(--paper)',
              outline: 'none',
              color: 'var(--ink)',
              font: 'inherit',
            }}
            maxLength={100}
          />
        </div>

        <span className="wf-tiny" style={{ marginTop: 10, display: 'block' }}>
          {t('catalog.edit.emoji')}
        </span>
        <div
          style={{
            marginTop: 6,
            display: 'grid',
            gridTemplateColumns: 'repeat(8, 1fr)',
            gap: 4,
          }}
        >
          {presetEmoji.map((e) => (
            <button
              key={e}
              onClick={() => setEmoji(e)}
              type="button"
              style={{
                background: e === emoji ? 'var(--ink)' : 'var(--paper)',
                border: '1.5px solid var(--line)',
                borderRadius: 8,
                fontSize: 18,
                padding: 4,
                aspectRatio: '1',
                cursor: 'pointer',
              }}
            >
              {e}
            </button>
          ))}
        </div>

        <span className="wf-tiny" style={{ marginTop: 10, display: 'block' }}>
          {t('catalog.edit.category')}
        </span>
        <select
          value={category ?? ''}
          onChange={(e) => setCategory(e.target.value || null)}
          style={{
            marginTop: 6,
            width: '100%',
            border: '1.5px solid var(--line)',
            borderRadius: 8,
            padding: '8px 10px',
            background: 'var(--paper)',
            font: 'inherit',
            fontSize: 14,
          }}
        >
          <option value="">{t('catalog.edit.category.none')}</option>
          {presetCategories.map((c) => (
            <option key={c} value={c}>
              {translateCategory(c)}
            </option>
          ))}
        </select>

        <div className="wf-row wf-gap-8" style={{ marginTop: 14 }}>
          <button
            type="button"
            className="wf-btn"
            onClick={onClose}
            style={{ cursor: 'pointer' }}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="wf-btn primary"
            onClick={() =>
              onSave({ name: name.trim(), emoji, category: category ?? null })
            }
            disabled={!name.trim() || pending}
            style={{
              flex: 1,
              cursor: !name.trim() || pending ? 'default' : 'pointer',
              opacity: !name.trim() || pending ? 0.5 : 1,
            }}
          >
            {pending ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function frequencyLabel(usage: number, t: ReturnType<typeof useT>): string {
  if (usage === 0) return t('catalog.frequency.new');
  if (usage >= 20) return t('catalog.frequency.weekly');
  if (usage >= 10) return t('catalog.frequency.often');
  if (usage >= 5) return t('catalog.frequency.sometimes');
  return `${usage}×`;
}

function formatPrice(cents: number | null, currency: string | null): string | null {
  if (cents == null) return null;
  const rubles = cents / 100;
  const sym =
    currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'RUB' || !currency ? '₽' : currency;
  return `${rubles % 1 === 0 ? rubles : rubles.toFixed(2)} ${sym}`;
}
