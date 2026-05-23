import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
  type OccurrenceDto,
  type TransferDto,
} from '../api';
import { Av, Icon, Tag, WfBody, type Member } from '../design';
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
 * Port of screens-states.jsx — incoming transfers + redemption requests.
 * One screen with both feeds: «Передачи мне» and «Запросы призов».
 */
export function Inbox({ me, family, onBack, onOpenDrawer }: Props) {
  const queryClient = useQueryClient();
  const t = useT();

  const transfersQuery = useQuery({
    queryKey: ['transfers-incoming', family.id, me.id],
    queryFn: () => api.listIncomingTransfers(family.id),
  });
  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });
  const tasksQuery = useQuery({
    queryKey: ['tasks', family.id],
    queryFn: () => api.listTasks(family.id),
  });
  // Fetch occurrences for the current month to look up titles
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1).toISOString().slice(0, 10);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().slice(0, 10);
  const occurrencesQuery = useQuery({
    queryKey: ['occurrences', family.id, monthStart, monthEnd],
    queryFn: () => api.listOccurrences(family.id, monthStart, monthEnd),
  });
  const redemptionsQuery = useQuery({
    queryKey: ['redemptions', family.id, 'pending'],
    queryFn: () => api.listRedemptions(family.id, 'pending'),
  });
  // Pending-approval queue — only fetched (and rendered) for users with
  // the `task.approve` permission. Family-summary's `myRole.permissions`
  // tells us up-front, so no extra round-trip when the section is empty
  // for a child viewer.
  const canApprove = family.myRole.permissions.includes('task.approve');
  const approvalsQuery = useQuery({
    queryKey: ['pending-approvals', family.id],
    queryFn: () => api.listPendingApprovals(family.id),
    enabled: canApprove,
  });

  const members = useMemo(
    () => (membersQuery.data?.members ?? []).map(memberFromDto),
    [membersQuery.data],
  );
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const occById = useMemo(
    () => new Map((occurrencesQuery.data?.occurrences ?? []).map((o) => [o.id, o])),
    [occurrencesQuery.data],
  );
  void tasksQuery;

  const acceptMut = useMutation({
    mutationFn: (id: string) => api.acceptTransfer(family.id, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transfers-incoming', family.id] });
      queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] });
    },
  });
  const rejectMut = useMutation({
    mutationFn: (id: string) => api.rejectTransfer(family.id, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['transfers-incoming', family.id] }),
  });

  const grantMut = useMutation({
    mutationFn: (id: string) => api.grantRedemption(family.id, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['redemptions', family.id] }),
  });
  const rejectRedMut = useMutation({
    mutationFn: (id: string) => api.rejectRedemption(family.id, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['redemptions', family.id] }),
  });
  const approveMut = useMutation({
    mutationFn: (id: string) => api.approveOccurrence(family.id, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pending-approvals', family.id] });
      queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] });
    },
  });
  const rejectApprovalMut = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      api.rejectOccurrence(family.id, input.id, input.reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pending-approvals', family.id] });
      queryClient.invalidateQueries({ queryKey: ['occurrences', family.id] });
    },
  });

  const transfers = transfersQuery.data?.transfers ?? [];
  const redemptions = redemptionsQuery.data?.redemptions ?? [];
  const approvals = approvalsQuery.data?.occurrences ?? [];

  const isAnyLoading =
    transfersQuery.isLoading || redemptionsQuery.isLoading || approvalsQuery.isLoading;

  return (
    <WfBody onBack={onBack}>
      <PageHeader title={t('inbox.title')} onBack={onBack} onOpenDrawer={onOpenDrawer} />

      {isAnyLoading && <span className="wf-hint">{t('common.loading')}</span>}

      {approvals.length > 0 && (
        <>
          <span className="wf-h3" style={{ marginTop: 4 }}>
            {t('inbox.approvals')} · {approvals.length}
          </span>
          {approvals.map((occ) => (
            <ApprovalRow
              key={occ.id}
              occ={occ}
              completer={
                occ.completedBy ? (memberById.get(occ.completedBy) ?? null) : null
              }
              tr={t}
              onApprove={() => approveMut.mutate(occ.id)}
              onReject={(reason) => rejectApprovalMut.mutate({ id: occ.id, reason })}
              pending={approveMut.isPending || rejectApprovalMut.isPending}
            />
          ))}
        </>
      )}

      {transfers.length > 0 && (
        <>
          <span className="wf-h3" style={{ marginTop: 4 }}>
            {t('inbox.transfers')} · {transfers.length}
          </span>
          {transfers.map((tr) => (
            <TransferRow
              key={tr.id}
              t={tr}
              occ={occById.get(tr.occurrenceId) ?? null}
              from={memberById.get(tr.fromUserId) ?? null}
              tr={t}
              onAccept={() => acceptMut.mutate(tr.id)}
              onReject={() => rejectMut.mutate(tr.id)}
              pending={acceptMut.isPending || rejectMut.isPending}
            />
          ))}
        </>
      )}

      {redemptions.length > 0 && (
        <>
          <span className="wf-h3" style={{ marginTop: 4 }}>
            {t('inbox.rewards')} · {redemptions.length}
          </span>
          {redemptions.map((r) => {
            const user = memberById.get(r.userId);
            // Reward name comes from the LEFT JOIN on the server; null
            // means the reward was deleted/archived after the redemption
            // was requested. Show "приз" as a fallback so the row still
            // reads sensibly instead of just "хочет · 50 ⭐".
            const rewardLabel = r.rewardName
              ? `${r.rewardEmoji ? r.rewardEmoji + ' ' : ''}${r.rewardName}`
              : t.locale === 'en'
                ? 'a reward'
                : 'приз';
            return (
              <div key={r.id} className="wf-card">
                <div className="wf-row wf-gap-10">
                  <Av m={user ?? null} size="md" />
                  <div className="wf-col" style={{ flex: 1, minWidth: 0 }}>
                    <span className="wf-label">
                      {user?.name ?? '—'} · {rewardLabel}
                    </span>
                    <span className="wf-hint">
                      {t('inbox.reward.wants')} · {r.costPoints} ⭐
                    </span>
                  </div>
                </div>
                <div className="wf-row wf-gap-8" style={{ marginTop: 10 }}>
                  <button
                    className="wf-btn"
                    onClick={() => rejectRedMut.mutate(r.id)}
                    disabled={rejectRedMut.isPending}
                    style={{ cursor: rejectRedMut.isPending ? 'default' : 'pointer' }}
                  >
                    {t('inbox.reward.reject')}
                  </button>
                  <button
                    className="wf-btn primary"
                    onClick={() => grantMut.mutate(r.id)}
                    disabled={grantMut.isPending}
                    style={{ flex: 1, cursor: grantMut.isPending ? 'default' : 'pointer' }}
                  >
                    {t('inbox.reward.grant')}
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}

      {!isAnyLoading &&
        transfers.length === 0 &&
        redemptions.length === 0 &&
        approvals.length === 0 && (
        <div className="wf-card subtle" style={{ textAlign: 'center', padding: 24 }}>
          <div style={{ fontSize: 36 }}>📭</div>
          <span className="wf-h3" style={{ display: 'block', marginTop: 8 }}>
            {t('inbox.empty.title')}
          </span>
          <span className="wf-hint" style={{ display: 'block', marginTop: 4 }}>
            {t('inbox.empty.hint')}
          </span>
        </div>
      )}
    </WfBody>
  );
}

function TransferRow({
  t,
  tr,
  occ,
  from,
  onAccept,
  onReject,
  pending,
}: {
  t: TransferDto;
  tr: TFn;
  occ: OccurrenceDto | null;
  from: Member | null;
  onAccept: () => void;
  onReject: () => void;
  pending: boolean;
}) {
  const remaining = Math.max(
    0,
    Math.round((new Date(t.expiresAt).getTime() - Date.now()) / 60_000),
  );
  return (
    <div className="wf-card">
      <div className="wf-row wf-gap-10">
        <Av m={from} size="md" />
        <div className="wf-col" style={{ flex: 1 }}>
          <span className="wf-label">{occ?.task.title ?? tr('inbox.transfer.task')}</span>
          <span className="wf-hint">
            {tr('inbox.transfer.from')} {from?.name ?? '—'}
          </span>
        </div>
        <Tag variant="warn">⏰ {remaining} {tr('inbox.transfer.timer')}</Tag>
      </div>
      {t.message && (
        <div className="wf-box subtle" style={{ marginTop: 8, padding: '8px 10px' }}>
          <span className="wf-tiny">{t.message}</span>
        </div>
      )}
      <div className="wf-row wf-gap-8" style={{ marginTop: 10 }}>
        <button
          className="wf-btn"
          onClick={onReject}
          disabled={pending}
          style={{ cursor: pending ? 'default' : 'pointer' }}
        >
          {tr('inbox.transfer.decline')}
        </button>
        <button
          className="wf-btn primary"
          onClick={onAccept}
          disabled={pending}
          style={{ flex: 1, cursor: pending ? 'default' : 'pointer' }}
        >
          {tr('inbox.transfer.accept')}
        </button>
      </div>
    </div>
  );
}

function ApprovalRow({
  occ,
  completer,
  tr,
  onApprove,
  onReject,
  pending,
}: {
  occ: OccurrenceDto;
  completer: Member | null;
  tr: TFn;
  onApprove: () => void;
  onReject: (reason: string) => void;
  pending: boolean;
}) {
  // Inline "reject with reason" — the textarea expands when the user
  // taps Reject the first time, so the simple case (approve in one tap)
  // stays a single click and rejection requires a deliberate second step.
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const ts = occ.completedAt
    ? new Date(occ.completedAt).toLocaleString(tr.locale === 'en' ? 'en-US' : 'ru-RU')
    : '';

  return (
    <div className="wf-card">
      <div className="wf-row wf-gap-10">
        <Av m={completer} size="md" />
        <div className="wf-col" style={{ flex: 1, minWidth: 0 }}>
          <span className="wf-label">
            {occ.task.title}
            {occ.task.points > 0 && (
              <span className="wf-tiny" style={{ marginLeft: 6, color: 'var(--hint)' }}>
                · +{occ.task.points} ⭐
              </span>
            )}
          </span>
          <span className="wf-hint">
            {completer?.name ?? '—'} · {ts}
          </span>
        </div>
        {(occ.photoIds?.length ?? 0) > 0 && (
          <Tag>📷 {occ.photoIds?.length}</Tag>
        )}
      </div>

      {rejecting && (
        <div className="wf-col" style={{ gap: 6, marginTop: 8 }}>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={tr('inbox.approval.reason.placeholder')}
            rows={2}
            maxLength={280}
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
      )}

      <div className="wf-row wf-gap-8" style={{ marginTop: 10 }}>
        {rejecting ? (
          <>
            <button
              className="wf-btn"
              onClick={() => {
                setRejecting(false);
                setReason('');
              }}
              disabled={pending}
              style={{ cursor: pending ? 'default' : 'pointer' }}
            >
              {tr('common.cancel')}
            </button>
            <button
              className="wf-btn"
              onClick={() => onReject(reason)}
              disabled={pending}
              style={{
                flex: 1,
                cursor: pending ? 'default' : 'pointer',
                background: 'var(--danger, #d33)',
                color: 'white',
                border: 'none',
              }}
            >
              {tr('inbox.approval.reject.confirm')}
            </button>
          </>
        ) : (
          <>
            <button
              className="wf-btn"
              onClick={() => setRejecting(true)}
              disabled={pending}
              style={{ cursor: pending ? 'default' : 'pointer' }}
            >
              {tr('inbox.approval.reject')}
            </button>
            <button
              className="wf-btn primary"
              onClick={onApprove}
              disabled={pending}
              style={{ flex: 1, cursor: pending ? 'default' : 'pointer', border: 'none' }}
            >
              {tr('inbox.approval.approve')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
