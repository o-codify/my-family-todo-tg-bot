import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type FamilySummary,
  type MeResponse,
  type PermissionRequestDto,
  type PermissionRequestType,
} from '../api';
import { Icon, WfBody } from '../design';
import { BottomSheet } from '../components/BottomSheet';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { useT, type TFn } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  onBack?: () => void;
  onOpenDrawer?: () => void;
};

const TYPES: PermissionRequestType[] = [
  'screen_time',
  'friend_visit',
  'spending',
  'food',
  'other',
];

const TYPE_EMOJI: Record<PermissionRequestType, string> = {
  screen_time: '📺',
  friend_visit: '👫',
  spending: '💸',
  food: '🍭',
  other: '❓',
};

/**
 * Free-form permission requests — kid asks, parent decides. Pending
 * requests sit at the top with cancel (own) or decide (parent) actions;
 * past decisions are listed below as read-only history.
 *
 * The parent's "decide" path also lives in Inbox so they can act on
 * requests without leaving their main triage screen.
 */
export function PermissionRequests({ me, family, onBack, onOpenDrawer }: Props) {
  const t = useT();
  const queryClient = useQueryClient();
  const toast = useToast();

  const canDecide = family.myRole.permissions.includes('permission.decide');

  const requestsQuery = useQuery({
    queryKey: ['permission-requests', family.id],
    queryFn: () => api.listPermissionRequests(family.id),
  });
  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });

  const requests = requestsQuery.data?.requests ?? [];
  const members = membersQuery.data?.members ?? [];
  const memberById = useMemo(
    () => new Map(members.map((m) => [m.id, m])),
    [members],
  );

  const createMut = useMutation({
    mutationFn: (payload: { type: PermissionRequestType; text: string }) =>
      api.createPermissionRequest(family.id, payload),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['permission-requests', family.id] }),
  });
  const decideMut = useMutation({
    mutationFn: (input: {
      id: string;
      decision: 'approved' | 'denied';
      reason?: string;
    }) =>
      api.decidePermissionRequest(family.id, input.id, input.decision, input.reason),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['permission-requests', family.id] }),
  });
  const cancelMut = useMutation({
    mutationFn: (id: string) => api.cancelPermissionRequest(family.id, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permission-requests', family.id] });
      toast.show({ message: t('common.deleted'), variant: 'success' });
    },
  });

  const pending = requests.filter((r) => r.status === 'pending');
  const decided = requests.filter((r) => r.status !== 'pending');

  const [composerOpen, setComposerOpen] = useState(false);

  return (
    <WfBody onBack={onBack}>
      <PageHeader
        title={t('permReq.title')}
        onBack={onBack}
        onOpenDrawer={onOpenDrawer}
        right={
          <button
            type="button"
            className="wf-btn primary"
            onClick={() => setComposerOpen(true)}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              cursor: 'pointer',
              border: 'none',
            }}
          >
            + {t('permReq.create')}
          </button>
        }
      />

      {requestsQuery.isLoading && <span className="wf-hint">{t('common.loading')}</span>}

      {!requestsQuery.isLoading && requests.length === 0 && (
        <div className="wf-card subtle" style={{ textAlign: 'center', padding: 18 }}>
          <div style={{ fontSize: 36 }}>🙋</div>
          <span className="wf-h3" style={{ display: 'block', marginTop: 8 }}>
            {t('permReq.empty.title')}
          </span>
          <span className="wf-hint" style={{ display: 'block', marginTop: 4 }}>
            {t('permReq.empty.hint')}
          </span>
        </div>
      )}

      {pending.length > 0 && (
        <div className="wf-col" style={{ gap: 4 }}>
          <span className="wf-tiny" style={{ marginTop: 4 }}>
            {t('permReq.section.pending')} · {pending.length}
          </span>
          {pending.map((r) => (
            <RequestRow
              key={r.id}
              request={r}
              requester={memberById.get(r.requesterUserId)}
              isMine={r.requesterUserId === me.id}
              canDecide={canDecide}
              onCancel={() => cancelMut.mutate(r.id)}
              onDecide={(decision, reason) =>
                decideMut.mutate({ id: r.id, decision, reason })
              }
              pending={cancelMut.isPending || decideMut.isPending}
              t={t}
            />
          ))}
        </div>
      )}

      {decided.length > 0 && (
        <div className="wf-col" style={{ gap: 4, marginTop: 10 }}>
          <span className="wf-tiny">{t('permReq.section.history')}</span>
          {decided.map((r) => (
            <RequestRow
              key={r.id}
              request={r}
              requester={memberById.get(r.requesterUserId)}
              isMine={r.requesterUserId === me.id}
              canDecide={false}
              t={t}
            />
          ))}
        </div>
      )}

      {composerOpen && (
        <Composer
          onClose={() => setComposerOpen(false)}
          onSubmit={(payload) => {
            createMut.mutate(payload, {
              onSuccess: () => setComposerOpen(false),
            });
          }}
          submitting={createMut.isPending}
          t={t}
        />
      )}
    </WfBody>
  );
}

function RequestRow({
  request,
  requester,
  isMine,
  canDecide,
  onCancel,
  onDecide,
  pending,
  t,
}: {
  request: PermissionRequestDto;
  requester?: { id: string; firstName: string; color: string };
  isMine: boolean;
  canDecide: boolean;
  onCancel?: () => void;
  onDecide?: (decision: 'approved' | 'denied', reason?: string) => void;
  pending?: boolean;
  t: TFn;
}) {
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState('');
  const statusTint =
    request.status === 'approved'
      ? '#1f9d55'
      : request.status === 'denied'
        ? '#d33'
        : request.status === 'cancelled'
          ? 'var(--hint)'
          : 'var(--ink)';
  return (
    <div className="wf-card" style={{ padding: 10 }}>
      <div className="wf-row wf-gap-8" style={{ alignItems: 'flex-start' }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: 'var(--faint)',
            border: '1.5px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            flex: 'none',
          }}
        >
          {TYPE_EMOJI[request.type]}
        </div>
        <div className="wf-col" style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <span className="wf-label" style={{ whiteSpace: 'pre-wrap' }}>
            {request.text}
          </span>
          <span className="wf-tiny" style={{ color: 'var(--hint)' }}>
            {requester?.firstName ?? '—'} · {t(`permReq.type.${request.type}`)}
          </span>
          {request.status !== 'pending' && (
            <span className="wf-tiny" style={{ color: statusTint }}>
              {t(`permReq.status.${request.status}`)}
              {request.decisionReason && ` — ${request.decisionReason}`}
            </span>
          )}
        </div>
      </div>

      {request.status === 'pending' && (
        <>
          {reasonOpen && (
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('permReq.reason.placeholder')}
              rows={2}
              style={{
                marginTop: 8,
                width: '100%',
                border: '1.5px solid var(--line)',
                borderRadius: 8,
                padding: '6px 10px',
                background: 'var(--paper)',
                font: 'inherit',
                color: 'var(--ink)',
                fontSize: 13,
                resize: 'vertical',
              }}
            />
          )}
          <div className="wf-row wf-gap-8" style={{ marginTop: 10 }}>
            {canDecide && onDecide ? (
              reasonOpen ? (
                <>
                  <button
                    className="wf-btn"
                    onClick={() => {
                      setReasonOpen(false);
                      setReason('');
                    }}
                    disabled={pending}
                    style={{ cursor: pending ? 'default' : 'pointer' }}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    className="wf-btn"
                    onClick={() => onDecide('denied', reason)}
                    disabled={pending}
                    style={{
                      flex: 1,
                      cursor: pending ? 'default' : 'pointer',
                      background: '#d33',
                      color: 'white',
                      border: 'none',
                    }}
                  >
                    {t('permReq.deny.confirm')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="wf-btn"
                    onClick={() => setReasonOpen(true)}
                    disabled={pending}
                    style={{ cursor: pending ? 'default' : 'pointer' }}
                  >
                    {t('permReq.deny')}
                  </button>
                  <button
                    className="wf-btn primary"
                    onClick={() => onDecide('approved')}
                    disabled={pending}
                    style={{
                      flex: 1,
                      cursor: pending ? 'default' : 'pointer',
                      border: 'none',
                    }}
                  >
                    {t('permReq.approve')}
                  </button>
                </>
              )
            ) : isMine && onCancel ? (
              <button
                className="wf-btn"
                onClick={onCancel}
                disabled={pending}
                style={{
                  flex: 1,
                  cursor: pending ? 'default' : 'pointer',
                }}
              >
                <Icon name="x" /> {t('permReq.cancel')}
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function Composer({
  onClose,
  onSubmit,
  submitting,
  t,
}: {
  onClose: () => void;
  onSubmit: (payload: { type: PermissionRequestType; text: string }) => void;
  submitting: boolean;
  t: TFn;
}) {
  const [type, setType] = useState<PermissionRequestType>('other');
  const [text, setText] = useState('');
  return (
    <BottomSheet onClose={onClose}>
      {({ close }) => (
        <>
          
          <div className="wf-col" style={{ gap: 10 }}>
            <span className="wf-h3">{t('permReq.create')}</span>

          <div className="wf-col" style={{ gap: 4 }}>
            <span className="wf-tiny">{t('permReq.field.type')}</span>
            <div className="wf-row wf-gap-6" style={{ flexWrap: 'wrap' }}>
              {TYPES.map((tp) => (
                <button
                  key={tp}
                  type="button"
                  className={'wf-seg' + (tp === type ? ' active' : '')}
                  onClick={() => setType(tp)}
                  style={{ fontSize: 12, padding: '4px 10px', cursor: 'pointer' }}
                >
                  {TYPE_EMOJI[tp]} {t(`permReq.type.${tp}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="wf-col" style={{ gap: 4 }}>
            <span className="wf-tiny">{t('permReq.field.text')}</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('permReq.field.text.placeholder')}
              rows={3}
              maxLength={280}
              autoFocus
              style={{
                border: '1.5px solid var(--line)',
                borderRadius: 8,
                padding: '6px 10px',
                background: 'var(--paper)',
                font: 'inherit',
                color: 'var(--ink)',
                fontSize: 13,
                resize: 'vertical',
              }}
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
                onClick={() => text.trim() && onSubmit({ type, text: text.trim() })}
                disabled={submitting || !text.trim()}
                style={{
                  flex: 1,
                  cursor: submitting || !text.trim() ? 'default' : 'pointer',
                  border: 'none',
                }}
              >
                {t('permReq.send')}
              </button>
            </div>
          </div>
        </>
      )}
    </BottomSheet>
  );
}
