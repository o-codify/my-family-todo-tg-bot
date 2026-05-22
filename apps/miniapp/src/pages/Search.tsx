import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  type CatalogItemDto,
  type FamilySummary,
  type MeResponse,
  type TaskDto,
  type TemplateDto,
} from '../api';
import { Icon, Seg, Tag, WfBody } from '../design';
import { PageHeader } from '../components/PageHeader';
import { useT, type TFn } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  /** Back when reached via in-app nav. */
  onBack?: () => void;
  /** Burger when reached via the drawer. */
  onOpenDrawer?: () => void;
};

export function Search({ me, family, onBack, onOpenDrawer }: Props) {
  void me;
  const t = useT();
  const FILTERS = [
    t('search.filter.all'),
    t('search.filter.tasks'),
    t('search.filter.catalog'),
    t('search.filter.templates'),
  ] as const;
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<string>(FILTERS[0]);

  const tasksQuery = useQuery({
    queryKey: ['tasks', family.id],
    queryFn: () => api.listTasks(family.id),
  });
  const catalogQuery = useQuery({
    queryKey: ['catalog', family.id, q],
    queryFn: () => api.listCatalog(family.id, q || undefined),
    enabled: q.length > 0,
  });
  const templatesQuery = useQuery({
    queryKey: ['templates', family.id],
    queryFn: () => api.listTemplates(family.id),
  });

  const matchedTasks = useMemo(() => {
    if (!q) return [];
    const ql = q.toLowerCase();
    return (tasksQuery.data?.tasks ?? []).filter((tt) =>
      tt.title.toLowerCase().includes(ql),
    );
  }, [tasksQuery.data, q]);

  const matchedCatalog = catalogQuery.data?.items ?? [];

  const matchedTemplates = useMemo(() => {
    if (!q) return [];
    const ql = q.toLowerCase();
    return (templatesQuery.data?.templates ?? []).filter((tt) =>
      tt.name.toLowerCase().includes(ql),
    );
  }, [templatesQuery.data, q]);

  const showTasks = filter === FILTERS[0] || filter === FILTERS[1];
  const showCatalog = filter === FILTERS[0] || filter === FILTERS[2];
  const showTemplates = filter === FILTERS[0] || filter === FILTERS[3];

  return (
    <WfBody onBack={onBack}>
      <PageHeader title={t('search.title')} onBack={onBack} onOpenDrawer={onOpenDrawer} />
      <div className="wf-box" style={{ padding: '10px 12px' }}>
        <div className="wf-row wf-gap-6">
          <Icon name="search" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('search.placeholder')}
            autoFocus
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
      <Seg
        items={[...FILTERS]}
        active={filter}
        onChange={(v) => setFilter(v)}
      />

      {!q && (
        <div className="wf-card subtle" style={{ textAlign: 'center', padding: 18 }}>
          <span className="wf-hint">{t('search.start')}</span>
        </div>
      )}

      {q && showTasks && matchedTasks.length > 0 && (
        <>
          <span className="wf-h3" style={{ marginTop: 4 }}>
            {t('search.tasks.heading')} · {matchedTasks.length}
          </span>
          {matchedTasks.map((tt) => (
            <TaskRow key={tt.id} t={tt} query={q} tr={t} />
          ))}
        </>
      )}
      {q && showCatalog && matchedCatalog.length > 0 && (
        <>
          <span className="wf-h3" style={{ marginTop: 4 }}>
            {t('search.catalog.heading')} · {matchedCatalog.length}
          </span>
          {matchedCatalog.map((c) => (
            <CatalogRow key={c.id} item={c} query={q} tr={t} />
          ))}
        </>
      )}
      {q && showTemplates && matchedTemplates.length > 0 && (
        <>
          <span className="wf-h3" style={{ marginTop: 4 }}>
            {t('search.templates.heading')} · {matchedTemplates.length}
          </span>
          {matchedTemplates.map((tt) => (
            <TemplateRow key={tt.id} t={tt} query={q} tr={t} />
          ))}
        </>
      )}
      {q &&
        matchedTasks.length === 0 &&
        matchedCatalog.length === 0 &&
        matchedTemplates.length === 0 && (
          <div className="wf-card subtle" style={{ textAlign: 'center', padding: 18 }}>
            <span className="wf-hint">{t('search.empty', { q })}</span>
          </div>
        )}
    </WfBody>
  );
}

function highlight(text: string, query: string): JSX.Element {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: 'var(--warn)', color: 'var(--ink)', padding: '0 2px' }}>
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function TaskRow({ t, query, tr }: { t: TaskDto; query: string; tr: TFn }) {
  return (
    <div className="wf-card compact">
      <div className="wf-row wf-gap-8">
        <Icon name="list" />
        <div className="wf-col" style={{ flex: 1 }}>
          <span className="wf-label">{highlight(t.title, query)}</span>
          <span className="wf-tiny">{typeLabel(t.type, tr)}</span>
        </div>
      </div>
    </div>
  );
}

function CatalogRow({
  item,
  query,
  tr,
}: {
  item: CatalogItemDto;
  query: string;
  tr: TFn;
}) {
  return (
    <div className="wf-card compact">
      <div className="wf-row wf-gap-8">
        <span style={{ fontSize: 20 }}>{item.emoji ?? '📦'}</span>
        <div className="wf-col" style={{ flex: 1 }}>
          <span className="wf-label">{highlight(item.name, query)}</span>
          <span className="wf-tiny">
            {item.usageCount}
            {tr('search.catalog.bought')}
          </span>
        </div>
      </div>
    </div>
  );
}

function TemplateRow({ t, query, tr }: { t: TemplateDto; query: string; tr: TFn }) {
  return (
    <div className="wf-card compact">
      <div className="wf-row wf-gap-8">
        <span style={{ fontSize: 20 }}>{t.emoji ?? '📋'}</span>
        <div className="wf-col" style={{ flex: 1 }}>
          <span className="wf-label">{highlight(t.name, query)}</span>
          <span className="wf-tiny">
            {tr('search.template.sub')} · {typeLabel(t.payload.type, tr)}
          </span>
        </div>
        {t.isSystem && <Tag>{tr('search.template.system')}</Tag>}
      </div>
    </div>
  );
}

function typeLabel(type: string, tr: TFn): string {
  switch (type) {
    case 'oneoff':
      return tr('search.type.oneoff');
    case 'recurring':
      return tr('search.type.recurring');
    case 'floating':
      return tr('search.type.floating');
    case 'queued':
      return tr('search.type.queued');
    default:
      return type;
  }
}
