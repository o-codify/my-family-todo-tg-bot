import { useMemo } from 'react';
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
import { useT, type TFn } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  onBack: () => void;
};

function memberFromDto(dto: FamilyMemberDto): Member {
  return {
    id: dto.id,
    name: dto.firstName,
    letter: dto.firstName.slice(0, 1).toUpperCase(),
    color: dto.color,
    role: dto.role.name,
    awayUntil: dto.awayUntil,
  };
}

/**
 * Port of screens-states.jsx — incoming transfers + redemption requests.
 * One screen with both feeds: «Передачи мне» and «Запросы призов».
 */
export function Inbox({ me, family, onBack }: Props) {
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

  const transfers = transfersQuery.data?.transfers ?? [];
  const redemptions = redemptionsQuery.data?.redemptions ?? [];

  const isAnyLoading = transfersQuery.isLoading || redemptionsQuery.isLoading;

  return (
    <WfBody onBack={onBack}>
      <div className="wf-row wf-gap-8">
        <button
          onClick={onBack}
          aria-label={t('common.back')}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--ink)' }}
        >
          <Icon name="chevL" />
        </button>
        <span className="wf-h2" style={{ flex: 1 }}>
          {t('inbox.title')}
        </span>
      </div>

      {isAnyLoading && <span className="wf-hint">{t('common.loading')}</span>}

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
            return (
              <div key={r.id} className="wf-card">
                <div className="wf-row wf-gap-10">
                  <Av m={user ?? null} size="md" />
                  <div className="wf-col" style={{ flex: 1 }}>
                    <span className="wf-label">{user?.name ?? '—'}</span>
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

      {!isAnyLoading && transfers.length === 0 && redemptions.length === 0 && (
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
