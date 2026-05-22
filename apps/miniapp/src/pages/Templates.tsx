import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type CreateTaskPayload,
  type FamilySummary,
  type MeResponse,
  type TaskTemplatePayload,
  type TemplateDto,
} from '../api';
import { Icon, Tag, WfBody } from '../design';
import { PageHeader } from '../components/PageHeader';
import { useT, type TFn } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  /** Back when reached via in-app nav. */
  onBack?: () => void;
  /** Burger when reached via the drawer. */
  onOpenDrawer?: () => void;
  onApply: (payload: CreateTaskPayload) => void;
};

/** Port of templates section (screens-templates-tasksheet-stats.jsx). */
export function Templates({ me, family, onBack, onOpenDrawer, onApply }: Props) {
  void me;
  const queryClient = useQueryClient();
  const t = useT();
  const listQuery = useQuery({
    queryKey: ['templates', family.id],
    queryFn: () => api.listTemplates(family.id),
  });

  const deleteMut = useMutation({
    mutationFn: (templateId: string) => api.deleteTemplate(family.id, templateId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['templates', family.id] }),
  });

  const items = listQuery.data?.templates ?? [];
  const mine = items.filter((tt) => !tt.isSystem);
  const system = items.filter((tt) => tt.isSystem);

  const applyTemplate = (tt: TemplateDto) => {
    const p = tt.payload;
    const payload: CreateTaskPayload = {
      title: p.title,
      type: p.type,
      schedule: p.schedule,
      points: p.points,
      photoRequired: p.photoRequired,
    };
    onApply(payload);
  };

  return (
    <WfBody onBack={onBack}>
      <PageHeader title={t('templates.title')} onBack={onBack} onOpenDrawer={onOpenDrawer} />

      {listQuery.isLoading && <span className="wf-hint">{t('common.loading')}</span>}

      {mine.length > 0 && (
        <>
          <span className="wf-h3" style={{ marginTop: 4 }}>
            {t('templates.section.own')}
          </span>
          {mine.map((tt) => (
            <TemplateCard
              key={tt.id}
              t={tt}
              tr={t}
              onApply={() => applyTemplate(tt)}
              onDelete={() => {
                if (confirm(t('templates.confirm.delete', { name: tt.name }))) {
                  deleteMut.mutate(tt.id);
                }
              }}
            />
          ))}
        </>
      )}

      {system.length > 0 && (
        <>
          <span className="wf-h3" style={{ marginTop: 4 }}>
            {t('templates.section.system')}
          </span>
          {system.map((tt) => (
            <TemplateCard key={tt.id} t={tt} tr={t} onApply={() => applyTemplate(tt)} />
          ))}
        </>
      )}

      {!listQuery.isLoading && items.length === 0 && (
        <div className="wf-card subtle" style={{ textAlign: 'center', padding: 24 }}>
          <div style={{ fontSize: 36 }}>📋</div>
          <span className="wf-h3" style={{ display: 'block', marginTop: 8 }}>
            {t('templates.empty.title')}
          </span>
          <span className="wf-hint" style={{ display: 'block', marginTop: 4 }}>
            {t('templates.empty.hint')}
          </span>
        </div>
      )}
    </WfBody>
  );
}

function TemplateCard({
  t,
  tr,
  onApply,
  onDelete,
}: {
  t: TemplateDto;
  tr: TFn;
  onApply: () => void;
  onDelete?: () => void;
}) {
  const p = t.payload as TaskTemplatePayload;
  return (
    <div className="wf-card">
      <div className="wf-row wf-gap-10">
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: 'var(--faint)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 20,
            flex: 'none',
          }}
        >
          {t.emoji ?? '📋'}
        </div>
        <div className="wf-col" style={{ flex: 1, minWidth: 0 }}>
          <span className="wf-label">{t.name}</span>
          <span className="wf-hint">{typeLabel(p.type, tr)}</span>
        </div>
        {t.isSystem && <Tag>{tr('templates.system.tag')}</Tag>}
      </div>
      <div className="wf-row wf-gap-8" style={{ marginTop: 10 }}>
        {onDelete && (
          <button
            className="wf-btn danger ghost"
            onClick={onDelete}
            style={{ cursor: 'pointer' }}
          >
            <Icon name="trash" />
          </button>
        )}
        <button
          className="wf-btn primary"
          onClick={onApply}
          style={{ flex: 1, cursor: 'pointer' }}
        >
          {tr('templates.use')}
        </button>
      </div>
    </div>
  );
}

function typeLabel(type: string, tr: TFn): string {
  switch (type) {
    case 'oneoff':
      return tr('templates.type.oneoff');
    case 'recurring':
      return tr('templates.type.recurring');
    case 'floating':
      return tr('templates.type.floating');
    case 'queued':
      return tr('templates.type.queued');
    default:
      return type;
  }
}
