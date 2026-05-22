import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  api,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
  type OccurrenceDto,
} from '../api';
import { Av, Icon, Seg, Tag, WfBody, type Member } from '../design';
import { useT } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  /** Occurrence id from the URL. We fetch the row ourselves so the page
   *  survives a refresh (route persists in the hash, occurrence does not). */
  occurrenceId: string;
  onBack: () => void;
  onDone: () => void;
};

type Mode = 'plain' | 'swap' | 'reward';

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
 * Transfer page — full screen (was a bottom-sheet, but content is too long
 * to fit comfortably in a 90vh sheet). Three modes (plain / swap / reward)
 * matching screens-transfer.jsx V1/V2/V3.
 *
 * Vertical rhythm follows the design verbatim:
 *  - 8px gap between unrelated rows (`.wf-tiny` label → input/card pair)
 *  - 4px gap between a `.wf-tiny` heading and its immediate target
 *  - Actions sit at the bottom; on a sufficiently tall screen we want them
 *    sticky-bottom, but `.wf-body` already scrolls, so we leave them inline
 *    and trust the body padding to keep them above the bottom-nav.
 */
export function Transfer({ me, family, occurrenceId, onBack, onDone }: Props) {
  const t = useT();
  const isEn = t.locale === 'en';

  // Fetch the occurrence ourselves so a hard refresh on /transfer/:id still
  // works. Synth "floating:<taskId>" ids aren't real occurrences yet — we
  // bounce back to calendar because there's nothing to transfer.
  const isSynth = occurrenceId.startsWith('floating:');
  const occurrenceQuery = useQuery({
    queryKey: ['occurrence', family.id, occurrenceId],
    queryFn: () => api.getOccurrence(family.id, occurrenceId),
    enabled: !isSynth,
  });
  const occurrence: OccurrenceDto | undefined = occurrenceQuery.data?.occurrence;
  const MODES = [
    { id: 'plain' as Mode, label: t('transfer.mode.plain') },
    { id: 'swap' as Mode, label: t('transfer.mode.swap') },
    { id: 'reward' as Mode, label: t('transfer.mode.reward') },
  ];
  const REWARD_KINDS = [
    { emoji: '💰', label: t('transfer.reward.money') },
    { emoji: '🍫', label: t('transfer.reward.treat') },
    { emoji: '📺', label: t('transfer.reward.screen') },
    { emoji: '🤝', label: t('transfer.reward.favor') },
    { emoji: '✏', label: t('transfer.reward.other') },
  ];

  const [mode, setMode] = useState<Mode>('plain');
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [swapIds, setSwapIds] = useState<string[]>([]);
  const [rewardKind, setRewardKind] = useState<string>(REWARD_KINDS[1]!.label);
  const [rewardName, setRewardName] = useState(
    isEn ? 'Chocolate bar' : 'Шоколадка',
  );
  const [rewardDesc, setRewardDesc] = useState(
    isEn ? 'Any from the store' : 'Любая на твой выбор из магазина',
  );

  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });

  const today = new Date();
  const twoWeeksLater = new Date(today.getTime() + 14 * 86_400_000);
  const swapRangeFrom = today.toISOString().slice(0, 10);
  const swapRangeTo = twoWeeksLater.toISOString().slice(0, 10);
  const swapOccQuery = useQuery({
    queryKey: ['occurrences', family.id, swapRangeFrom, swapRangeTo],
    queryFn: () => api.listOccurrences(family.id, swapRangeFrom, swapRangeTo),
    enabled: mode === 'swap' && selected != null,
  });

  const members = useMemo(
    () => (membersQuery.data?.members ?? []).map(memberFromDto),
    [membersQuery.data],
  );
  const recipients = members.filter((m) => m.id !== me.id);
  const selectedMember = members.find((m) => m.id === selected);

  const recipientOccurrences = useMemo(() => {
    if (!swapOccQuery.data || !selected) return [];
    return swapOccQuery.data.occurrences.filter(
      (o) => o.assigneeId === selected && o.status === 'pending',
    );
  }, [swapOccQuery.data, selected]);

  const swapBalance = useMemo(() => {
    if (!occurrence) return 0;
    if (swapIds.length === 0) return occurrence.task.points;
    const taken = recipientOccurrences
      .filter((o) => swapIds.includes(o.id))
      .reduce((sum, o) => sum + o.task.points, 0);
    return occurrence.task.points - taken;
  }, [swapIds, recipientOccurrences, occurrence]);

  const mut = useMutation({
    mutationFn: () => {
      if (!selected || !occurrence) throw new Error('no recipient or occurrence');
      return api.createTransfer(family.id, {
        occurrenceId: occurrence.id,
        toUserId: selected,
        mode,
        message: message.trim() || null,
      });
    },
    onSuccess: onDone,
  });

  const taskMeta = useMemo(() => {
    if (!occurrence) return '';
    const bits: string[] = [];
    bits.push(isEn ? 'currently yours' : 'сейчас твоя');
    if (occurrence.scheduledTime) {
      bits.push(`${isEn ? 'by' : 'до'} ${occurrence.scheduledTime.slice(0, 5)}`);
    }
    if (occurrence.task.points > 0) bits.push(`+${occurrence.task.points}`);
    return bits.join(' · ');
  }, [occurrence, isEn]);

  const canSubmit =
    !!selected && !mut.isPending && (mode !== 'swap' || swapIds.length > 0);

  const submitLabel =
    mode === 'swap'
      ? t('transfer.submit.swap')
      : mode === 'reward'
        ? t('transfer.submit.reward')
        : t('transfer.submit.plain');

  // Tiny helper to keep "label + card/input" pairs visually grouped. Without
  // a wrapper the WfBody's default 8px gap is applied to BOTH the label and
  // the following control, which makes the design look airy. We collapse
  // that pair into a 4px gap.
  const fieldGap = { marginTop: 4 };

  // Synth floating ids can't be transferred (no real occurrence row).
  // Loading / not-found states: keep the chrome (header), show a hint
  // instead of the form.
  if (isSynth || (!occurrenceQuery.isLoading && !occurrence)) {
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
            {t('transfer.title.plain')}
          </span>
        </div>
        <div className="wf-card subtle" style={{ textAlign: 'center', padding: 18 }}>
          <span className="wf-hint">
            {isEn ? 'This task cannot be transferred' : 'Эту задачу нельзя передать'}
          </span>
        </div>
      </WfBody>
    );
  }

  if (!occurrence) {
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
            {t('transfer.title.plain')}
          </span>
        </div>
        <span className="wf-hint">{t('common.loading')}</span>
      </WfBody>
    );
  }

  return (
    <WfBody onBack={onBack}>
      {/* Header — chevL + title (per design V1/V2/V3) */}
      <div className="wf-row wf-gap-8">
        <button
          onClick={onBack}
          aria-label={t('common.back')}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--ink)' }}
        >
          <Icon name="chevL" />
        </button>
        <span className="wf-h2" style={{ flex: 1 }}>
          {mode === 'swap'
            ? t('transfer.title.swap')
            : mode === 'reward'
              ? t('transfer.title.reward')
              : t('transfer.title.plain')}
        </span>
      </div>

      <Seg
        items={MODES.map((m) => m.label)}
        active={MODES.find((m) => m.id === mode)?.label ?? MODES[0]!.label}
        onChange={(v) => {
          const next = MODES.find((m) => m.label === v);
          if (next) setMode(next.id);
        }}
        full
      />

      {/* Task being given — compact card. Swap/reward modes show a "Ты отдаёшь"
          micro-label above the card; plain doesn't (task is the entire focus). */}
      {mode === 'plain' ? (
        <div className="wf-card">
          <div className="wf-row wf-gap-10">
            <span style={{ fontSize: 22, width: 32, textAlign: 'center', flex: 'none' }}>
              <Icon name="trash" />
            </span>
            <div className="wf-col" style={{ flex: 1 }}>
              <span className="wf-label">{occurrence.task.title}</span>
              <span className="wf-tiny">{taskMeta}</span>
            </div>
          </div>
        </div>
      ) : (
        <>
          <span className="wf-tiny">{t('transfer.giving')}</span>
          <div className="wf-card" style={{ ...fieldGap, padding: 10 }}>
            <div className="wf-row wf-gap-10">
              <span style={{ fontSize: 22, width: 32, textAlign: 'center', flex: 'none' }}>
                <Icon name="trash" />
              </span>
              <div className="wf-col" style={{ flex: 1 }}>
                <span className="wf-label">{occurrence.task.title}</span>
                <span className="wf-hint">
                  {occurrence.scheduledTime &&
                    `${isEn ? 'by' : 'до'} ${occurrence.scheduledTime.slice(0, 5)}`}
                  {occurrence.scheduledTime && occurrence.task.points > 0 && ' · '}
                  {occurrence.task.points > 0 && `+${occurrence.task.points}`}
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ─── plain ─────────────────────────────────────── */}
      {mode === 'plain' && (
        <>
          <span className="wf-tiny">{t('transfer.to.plain')}</span>
          {recipients.length === 0 && (
            <div className="wf-card subtle" style={fieldGap}>
              <span className="wf-hint">{t('transfer.alone')}</span>
            </div>
          )}
          <div className="wf-col wf-gap-6" style={fieldGap}>
            {recipients.map((m) => {
              const away = m.awayUntil && new Date(m.awayUntil) > new Date();
              const sel = selected === m.id;
              return (
                <div
                  key={m.id}
                  className="wf-card compact"
                  onClick={() => !away && setSelected(m.id)}
                  style={{
                    cursor: away ? 'not-allowed' : 'pointer',
                    opacity: away ? 0.4 : 1,
                    borderColor: sel ? 'var(--ink)' : undefined,
                  }}
                >
                  <div className="wf-row wf-gap-10">
                    <Av m={m} size="md" />
                    <div className="wf-col" style={{ flex: 1 }}>
                      <span className="wf-label">{m.name}</span>
                      <span className="wf-tiny">
                        {away
                          ? `${t('transfer.away')} ${(m.awayUntil ?? '').slice(0, 10)}`
                          : t('transfer.online')}
                      </span>
                    </div>
                    <Radio sel={sel} />
                  </div>
                </div>
              );
            })}
          </div>

          <span className="wf-tiny">{t('transfer.message')}</span>
          <div className="wf-box" style={{ ...fieldGap, padding: '10px 12px' }}>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t('transfer.message.placeholder')}
              className="wf-label"
              style={{
                width: '100%',
                border: 'none',
                background: 'transparent',
                outline: 'none',
                color: 'var(--ink)',
                font: 'inherit',
              }}
              maxLength={200}
            />
          </div>

          <div className="wf-card subtle">
            <div className="wf-row wf-gap-8">
              <Icon name="clock" />
              <div className="wf-col" style={{ flex: 1 }}>
                <span className="wf-label">{t('transfer.ttl.title')}</span>
                <span className="wf-tiny">{t('transfer.ttl.hint')}</span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ─── swap ─────────────────────────────────────── */}
      {mode === 'swap' && (
        <>
          <span className="wf-tiny">{t('transfer.swap.partner')}</span>
          <div className="wf-col wf-gap-6" style={fieldGap}>
            <RecipientPicker
              recipients={recipients}
              selected={selected}
              onSelect={(id) => {
                setSelected(id);
                setSwapIds([]);
              }}
            />
          </div>

          {selected && (
            <>
              <span className="wf-tiny">
                {t('transfer.swap.pick', { name: selectedMember?.name ?? '—' })}
              </span>
              {swapOccQuery.isLoading && (
                <span className="wf-hint" style={fieldGap}>
                  {t('common.loading')}
                </span>
              )}
              {!swapOccQuery.isLoading && recipientOccurrences.length === 0 && (
                <div className="wf-card subtle" style={fieldGap}>
                  <span className="wf-hint">
                    {t('transfer.swap.empty', { name: selectedMember?.name ?? '—' })}
                  </span>
                </div>
              )}
              <div className="wf-col wf-gap-6" style={fieldGap}>
                {recipientOccurrences.map((o) => {
                  const checked = swapIds.includes(o.id);
                  return (
                    <div
                      key={o.id}
                      className="wf-card compact"
                      onClick={() => {
                        if (checked) {
                          setSwapIds(swapIds.filter((x) => x !== o.id));
                        } else if (swapIds.length < 2) {
                          setSwapIds([...swapIds, o.id]);
                        }
                      }}
                      style={{
                        padding: '8px 10px',
                        cursor: 'pointer',
                        borderColor: checked ? 'var(--ink)' : undefined,
                      }}
                    >
                      <div className="wf-row wf-gap-8">
                        <span style={{ fontSize: 18, width: 22, textAlign: 'center', flex: 'none' }}>
                          📌
                        </span>
                        <div className="wf-col" style={{ flex: 1 }}>
                          <span className="wf-label">{o.task.title}</span>
                          <span className="wf-tiny">
                            {o.scheduledDate ?? t('transfer.swap.noDate')}
                            {o.task.points > 0 ? ` · +${o.task.points}` : ''}
                          </span>
                        </div>
                        <span className={'wf-check' + (checked ? ' done' : '')}>
                          {checked && <Icon name="check" />}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {swapIds.length > 0 && (
                <div className="wf-card subtle">
                  <div className="wf-spread">
                    <span className="wf-tiny">{t('transfer.swap.balance')}</span>
                    <Tag variant={swapBalance >= 0 ? 'success' : 'warn'}>
                      {swapBalance >= 0 ? '+' : ''}
                      {swapBalance}{' '}
                      {swapBalance >= 0
                        ? t('transfer.swap.favorMe')
                        : t('transfer.swap.againstMe')}
                    </Tag>
                  </div>
                </div>
              )}
            </>
          )}

          <span className="wf-tiny">{t('transfer.message')}</span>
          <div className="wf-box" style={{ ...fieldGap, padding: '10px 12px' }}>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t('transfer.message.swap.placeholder')}
              className="wf-label"
              style={{
                width: '100%',
                border: 'none',
                background: 'transparent',
                outline: 'none',
                color: 'var(--ink)',
                font: 'inherit',
              }}
              maxLength={200}
            />
          </div>
        </>
      )}

      {/* ─── reward ────────────────────────────────────── */}
      {mode === 'reward' && (
        <>
          <span className="wf-tiny">{t('transfer.to.recipient')}</span>
          <div className="wf-col wf-gap-6" style={fieldGap}>
            <RecipientPicker
              recipients={recipients}
              selected={selected}
              onSelect={setSelected}
            />
          </div>

          <span className="wf-tiny">{t('transfer.reward.what')}</span>
          <div className="wf-row wf-gap-6" style={{ ...fieldGap, flexWrap: 'wrap' }}>
            {REWARD_KINDS.map((k) => {
              const active = rewardKind === k.label;
              return (
                <span
                  key={k.label}
                  onClick={() => setRewardKind(k.label)}
                  className={'wf-tag' + (active ? ' solid' : '')}
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                >
                  {k.emoji} {k.label}
                </span>
              );
            })}
          </div>

          {/* Reward detail */}
          <div className="wf-card" style={{ padding: 10 }}>
            <div className="wf-row wf-gap-10">
              <span
                style={{
                  fontSize: 28,
                  width: 40,
                  textAlign: 'center',
                  flex: 'none',
                }}
              >
                {REWARD_KINDS.find((k) => k.label === rewardKind)?.emoji ?? '🎁'}
              </span>
              <div className="wf-col" style={{ flex: 1, gap: 4 }}>
                <input
                  value={rewardName}
                  onChange={(e) => setRewardName(e.target.value)}
                  placeholder={t('transfer.reward.name.placeholder')}
                  className="wf-label"
                  style={{
                    width: '100%',
                    border: 'none',
                    background: 'transparent',
                    outline: 'none',
                    color: 'var(--ink)',
                    font: 'inherit',
                  }}
                  maxLength={60}
                />
                <input
                  value={rewardDesc}
                  onChange={(e) => setRewardDesc(e.target.value)}
                  placeholder={t('transfer.reward.desc.placeholder')}
                  className="wf-hint"
                  style={{
                    width: '100%',
                    border: 'none',
                    background: 'transparent',
                    outline: 'none',
                    color: 'var(--hint)',
                    font: 'inherit',
                  }}
                  maxLength={120}
                />
              </div>
            </div>
          </div>

          <div className="wf-card subtle">
            <div className="wf-row wf-gap-8">
              <Icon name="clock" />
              <span className="wf-tiny" style={{ flex: 1 }}>
                {selectedMember
                  ? t('transfer.reward.timer', { name: selectedMember.name })
                  : t('transfer.reward.timer.fallback')}
              </span>
            </div>
          </div>
        </>
      )}

      {mut.error && (
        <div className="wf-card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>
          {t('transfer.err')}
        </div>
      )}

      {/* Actions */}
      <div className="wf-row wf-gap-8" style={{ marginTop: 'auto', paddingTop: 8 }}>
        <button className="wf-btn" onClick={onBack} style={{ cursor: 'pointer' }}>
          {t('common.cancel')}
        </button>
        <button
          className="wf-btn primary lg"
          onClick={() => mut.mutate()}
          disabled={!canSubmit}
          style={{
            flex: 1,
            cursor: canSubmit ? 'pointer' : 'default',
            opacity: canSubmit ? 1 : 0.5,
          }}
        >
          {mut.isPending ? t('common.sending') : submitLabel}
        </button>
      </div>
    </WfBody>
  );
}

function RecipientPicker({
  recipients,
  selected,
  onSelect,
}: {
  recipients: Member[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  if (recipients.length === 0) {
    return (
      <div className="wf-card subtle">
        <span className="wf-hint">{t('transfer.alone')}</span>
      </div>
    );
  }
  return (
    <>
      {recipients.map((m) => {
        const away = m.awayUntil && new Date(m.awayUntil) > new Date();
        const sel = selected === m.id;
        return (
          <div
            key={m.id}
            className="wf-card compact"
            onClick={() => !away && onSelect(m.id)}
            style={{
              padding: '8px 10px',
              cursor: away ? 'not-allowed' : 'pointer',
              opacity: away ? 0.4 : 1,
              borderColor: sel ? 'var(--ink)' : undefined,
            }}
          >
            <div className="wf-row wf-gap-10">
              <Av m={m} size="sm" />
              <div className="wf-col" style={{ flex: 1 }}>
                <span className="wf-label">{m.name}</span>
                <span className="wf-tiny">
                  {away ? t('transfer.away.brief') : t('transfer.online.brief')}
                </span>
              </div>
              <Radio sel={sel} />
            </div>
          </div>
        );
      })}
    </>
  );
}

function Radio({ sel }: { sel: boolean }) {
  return (
    <span
      style={{
        width: 20,
        height: 20,
        borderRadius: 999,
        border: '1.5px solid var(--line)',
        background: sel ? 'var(--ink)' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--paper)',
      }}
    >
      {sel && <Icon name="check" />}
    </span>
  );
}
