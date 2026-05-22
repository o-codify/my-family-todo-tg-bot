import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CatalogItemDto, type FamilySummary, type MeResponse } from '../api';
import { Icon, Tag, WfBody } from '../design';
import { PageHeader } from '../components/PageHeader';
import { useT } from '../i18n';

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
              {cat} · {count}
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
              onDelete={() => {
                if (confirm(t('catalog.confirm.delete.item', { name: it.name })))
                  deleteMut.mutate(it.id);
              }}
            />
          ))}
        </div>
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
        <Tag>{t('catalog.inCategory', { n: visible.length, cat: activeCat })}</Tag>
      )}
    </WfBody>
  );
}

function CatalogCard({
  it,
  onDelete,
}: {
  it: CatalogItemDto;
  onDelete: () => void;
}) {
  const t = useT();
  const freq = frequencyLabel(it.usageCount, t);
  const price = formatPrice(it.lastPriceCents, it.lastCurrency);
  return (
    <div className="wf-card" style={{ padding: 10, position: 'relative' }}>
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
            onClick={onDelete}
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
