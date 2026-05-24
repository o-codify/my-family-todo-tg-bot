import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type ApiError, type FamilySummary, type MeResponse } from '../api';
import { Av, AvStack, Icon, Tag, WfBody, type Member } from '../design';
import { CopyButton } from '../components/CopyButton';
import { useT, type TFn } from '../i18n';

type Props = {
  me: MeResponse;
  initialInviteCode?: string;
  onCreate: (input: {
    name: string;
    color: string;
    avatarEmoji: string | null;
  }) => Promise<{ family: FamilySummary }>;
  onJoin: (code: string) => Promise<unknown>;
  onComplete: () => void;
  /** Optional escape hatch. The initial onboarding (no families yet)
   *  has nowhere to go back to, so we omit this. When the same flow is
   *  reused for "add another family", the caller passes a cancel that
   *  pops back to FamilyHome. */
  onCancel?: () => void;
  createError: ApiError | null;
  joinError: ApiError | null;
};

const COLORS: Array<{ c: string; n: string }> = [
  { c: '#FF6B6B', n: 'Coral' },
  { c: '#4ECDC4', n: 'Sky' },
  { c: '#FFD93D', n: 'Sun' },
  { c: '#6BCB77', n: 'Mint' },
  { c: '#A66CFF', n: 'Lavender' },
  { c: '#FF9F68', n: 'Peach' },
  { c: '#3D8BFD', n: 'Ocean' },
  { c: '#E83E8C', n: 'Rose' },
];

const FAMILY_EMOJI: string[] = [
  '🏠', '🏡', '🛋', '🪴',
  '🌻', '🌳', '🌸', '🍀',
  '🐱', '🐶', '🦊', '🐻',
  '🍰', '🍩', '🎈', '🎉',
];

/**
 * Port of screens-onboarding.jsx with live wiring:
 * - OnbV1 → ChooseStep
 * - OnbV2 → CreateStep (full: avatar emoji picker, name, color, name-preview)
 * - OnbV3 → JoinStep (6-box code, preview)
 * - Post-create → ShareStep (the "Пригласить" card from OnbV4, but active now)
 */
export function Onboarding({
  me,
  initialInviteCode,
  onCreate,
  onJoin,
  onComplete,
  onCancel,
  createError,
  joinError,
}: Props) {
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>(
    initialInviteCode ? 'join' : 'choose',
  );
  const [justCreated, setJustCreated] = useState<FamilySummary | null>(null);

  if (justCreated) {
    return <ShareStep family={justCreated} onDone={onComplete} />;
  }

  if (mode === 'choose') {
    return (
      <ChooseStep
        onCreateClick={() => setMode('create')}
        onJoinClick={() => setMode('join')}
        onCancel={onCancel}
      />
    );
  }
  if (mode === 'create') {
    return (
      <CreateStep
        me={me}
        onBack={() => setMode('choose')}
        onSubmit={async (input) => {
          const result = await onCreate(input);
          setJustCreated(result.family);
        }}
        error={createError}
      />
    );
  }
  return (
    <JoinStep
      initialCode={initialInviteCode}
      onBack={() => setMode('choose')}
      onSubmit={onJoin}
      error={joinError}
    />
  );
}

/* ─── O1 — Welcome (verbatim port of OnbV1) ────────────── */
function ChooseStep({
  onCreateClick,
  onJoinClick,
  onCancel,
}: {
  onCreateClick: () => void;
  onJoinClick: () => void;
  /** Optional — shown as a top-left back button when set (the "add
   *  another family" flow has somewhere to return to). */
  onCancel?: () => void;
}) {
  const t = useT();
  return (
    <WfBody
      style={{ alignItems: 'center', textAlign: 'center', padding: '28px 24px 28px', gap: 14 }}
    >
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          aria-label={t('common.back')}
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            background: 'var(--ink)',
            color: 'var(--paper)',
            border: 'none',
            borderRadius: 999,
            width: 36,
            height: 36,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <Icon name="chevL" />
        </button>
      )}
      <div
        style={{
          width: 80,
          height: 80,
          borderRadius: 20,
          border: '1.5px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 38,
          marginTop: 16,
          flex: 'none',
        }}
      >
        👨‍👩‍👧‍👦
      </div>

      <div className="wf-col" style={{ alignItems: 'center', marginTop: 8, gap: 4 }}>
        <span className="wf-h1" style={{ fontSize: 28 }}>
          My Family Todo
        </span>
        <span className="wf-hint">{t('onb.intro.sub')}</span>
      </div>

      <div className="wf-col wf-gap-10" style={{ alignSelf: 'stretch', marginTop: 12 }}>
        <div className="wf-row wf-gap-10">
          <span style={{ fontSize: 22 }}>📅</span>
          <span className="wf-label">{t('onb.bullet.daily')}</span>
        </div>
        <div className="wf-row wf-gap-10">
          <span style={{ fontSize: 22 }}>🔄</span>
          <span className="wf-label">{t('onb.bullet.queues')}</span>
        </div>
        <div className="wf-row wf-gap-10">
          <span style={{ fontSize: 22 }}>⭐</span>
          <span className="wf-label">{t('onb.bullet.rewards')}</span>
        </div>
      </div>

      <div style={{ flex: 1 }} />

      <div className="wf-col wf-gap-8" style={{ alignSelf: 'stretch' }}>
        <button
          className="wf-btn primary lg block"
          onClick={onCreateClick}
          style={{ cursor: 'pointer' }}
        >
          {t('onb.create')}
        </button>
        <button
          className="wf-btn lg block"
          onClick={onJoinClick}
          style={{ cursor: 'pointer' }}
        >
          {t('onb.join')}
        </button>
      </div>
    </WfBody>
  );
}

/* ─── O2 — Create (port of OnbV2 with active emoji picker) ── */
function CreateStep({
  me,
  onBack,
  onSubmit,
  error,
}: {
  me: MeResponse;
  onBack: () => void;
  onSubmit: (input: {
    name: string;
    color: string;
    avatarEmoji: string | null;
  }) => Promise<void>;
  error: ApiError | null;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(me.color || COLORS[0]!.c);
  const [emoji, setEmoji] = useState<string>('🏠');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const meAsMember: Member = {
    id: me.id,
    name: me.firstName,
    letter: me.firstName.slice(0, 1).toUpperCase(),
    color,
    role: 'Owner',
  };
  const submit = async () => {
    if (!trimmed) return;
    setBusy(true);
    try {
      await onSubmit({ name: trimmed, color, avatarEmoji: emoji });
    } finally {
      setBusy(false);
    }
  };

  return (
    <WfBody>
      {/* Header */}
      <div className="wf-row wf-gap-8">
        <button
          onClick={onBack}
          aria-label={t('common.back')}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--ink)' }}
        >
          <Icon name="chevL" />
        </button>
        <span className="wf-h2" style={{ flex: 1 }}>
          {t('onb.create.title')}
        </span>
      </div>

      {/* Avatar emoji picker — port of lines 46-54 with active picker */}
      <span className="wf-hint" style={{ marginTop: 8 }}>
        {t('onb.create.avatar')}
      </span>
      <div className="wf-row wf-gap-10">
        <button
          onClick={() => setPickerOpen(!pickerOpen)}
          style={{
            width: 64,
            height: 64,
            borderRadius: 16,
            border: '1.5px dashed var(--softline)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 30,
            background: 'var(--faint)',
            cursor: 'pointer',
            padding: 0,
          }}
          aria-label={t('onb.create.pick')}
        >
          {emoji}
        </button>
        <button
          className="wf-btn ghost"
          onClick={() => setPickerOpen(!pickerOpen)}
          style={{ cursor: 'pointer' }}
        >
          {t('onb.create.pick')}
        </button>
      </div>
      {pickerOpen && (
        <div
          className="wf-card subtle"
          style={{ padding: 10, marginTop: 4 }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(8, 1fr)',
              gap: 6,
            }}
          >
            {FAMILY_EMOJI.map((e) => (
              <button
                key={e}
                onClick={() => {
                  setEmoji(e);
                  setPickerOpen(false);
                }}
                style={{
                  width: '100%',
                  aspectRatio: '1',
                  borderRadius: 8,
                  border: e === emoji ? '1.5px solid var(--ink)' : '1.5px solid var(--softline)',
                  background: 'var(--paper)',
                  fontSize: 22,
                  cursor: 'pointer',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Name input */}
      <span className="wf-hint" style={{ marginTop: 4 }}>
        {t('onb.create.name')}
      </span>
      <div className="wf-box" style={{ padding: '10px 12px' }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('onb.create.name.placeholder')}
          autoFocus
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
      </div>

      {/* Color picker */}
      <span className="wf-hint" style={{ marginTop: 4 }}>
        {t('onb.create.color')}
      </span>
      <div className="wf-row wf-gap-8" style={{ flexWrap: 'wrap' }}>
        {COLORS.map((s) => {
          const sel = s.c === color;
          return (
            <span
              key={s.c}
              className="wf-mc"
              onClick={() => setColor(s.c)}
              style={{
                width: 32,
                height: 32,
                borderRadius: 999,
                background: s.c,
                border: sel ? '2.5px solid var(--ink)' : '1.5px solid var(--line)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {sel ? '✓' : ''}
            </span>
          );
        })}
      </div>

      {/* Name preview */}
      <span className="wf-hint" style={{ marginTop: 4 }}>
        {t('onb.create.myname')}
      </span>
      <div className="wf-box" style={{ padding: '10px 12px' }}>
        <div className="wf-row wf-gap-8">
          <Av m={meAsMember} size="sm" />
          <span className="wf-label">{me.firstName}</span>
          <span className="wf-tiny" style={{ marginLeft: 'auto' }}>
            {t('onb.create.fromTg')}
          </span>
        </div>
      </div>

      {error && (
        <div
          className="wf-card"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
        >
          {describeError(error, t)}
        </div>
      )}

      {/* Submit */}
      <button
        className="wf-btn primary lg block sticky-bottom"
        onClick={() => void submit()}
        disabled={busy || !trimmed}
        style={{
          cursor: busy || !trimmed ? 'default' : 'pointer',
          opacity: busy || !trimmed ? 0.5 : 1,
        }}
      >
        {busy ? t('onb.create.submitting') : t('onb.create.submit')}
      </button>
    </WfBody>
  );
}

/* ─── Post-create: invite NOW ───────────────────────── */
function ShareStep({ family, onDone }: { family: FamilySummary; onDone: () => void }) {
  const t = useT();
  const botUsername = import.meta.env.VITE_TG_BOT_USERNAME as string | undefined;
  const inviteLink = botUsername
    ? `https://t.me/${botUsername}?start=${family.inviteCode}`
    : null;

  const handleShare = () => {
    if (!inviteLink) return;
    // Telegram share URL — opens the share sheet from inside Mini App / TG client.
    const share = `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent(t('onb.share.text', { name: family.name }))}`;
    window.open(share, '_blank');
  };

  return (
    <WfBody style={{ padding: '28px 20px 20px', gap: 14 }}>
      <div
        style={{
          width: 80,
          height: 80,
          borderRadius: 20,
          border: '1.5px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 38,
          alignSelf: 'center',
          marginTop: 16,
          flex: 'none',
        }}
      >
        🎉
      </div>
      <div className="wf-col" style={{ alignItems: 'center', gap: 4 }}>
        <span className="wf-h1" style={{ fontSize: 24 }}>
          {family.name}
        </span>
        <span className="wf-hint">{t('onb.share.sub')}</span>
      </div>

      <span className="wf-hint" style={{ marginTop: 8 }}>
        {t('onb.share.code')}
      </span>
      <div
        className="wf-box"
        style={{
          padding: '14px 16px',
          textAlign: 'center',
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontWeight: 700,
          fontSize: 28,
          letterSpacing: '0.16em',
        }}
      >
        {family.inviteCode}
      </div>

      {inviteLink && (
        <>
          <span className="wf-hint">{t('onb.share.linkHint')}</span>
          <div
            className="wf-box"
            style={{
              padding: '8px 12px',
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              fontSize: 11,
              wordBreak: 'break-all',
              color: 'var(--hint)',
            }}
          >
            {inviteLink}
          </div>
        </>
      )}

      {/* Copy button uses the shared <CopyButton/> so its visual states
       *  (idle / ok / err) stay in lockstep with the Profile invite
       *  card and the ICS panel. The explicit `height: 38` keeps the
       *  Share button next to it from shifting when ✓ swaps in. */}
      <div className="wf-row wf-gap-8" style={{ marginTop: 4, alignItems: 'stretch' }}>
        <CopyButton
          value={inviteLink ?? family.inviteCode}
          label={t('onb.share.copy')}
          variant="block"
          style={{
            flex: 1,
            height: 38,
            padding: '0 14px',
            lineHeight: 1,
            transition: 'border-color 0.15s, color 0.15s, background 0.15s',
          }}
        />
        {inviteLink && (
          <button
            className="wf-btn primary block"
            onClick={handleShare}
            style={{
              flex: 1,
              cursor: 'pointer',
              height: 38,
              padding: '0 14px',
              lineHeight: 1,
            }}
          >
            {t('onb.share.share')}
          </button>
        )}
      </div>

      <div style={{ flex: 1 }} />

      <button
        className="wf-btn lg block"
        onClick={onDone}
        style={{ cursor: 'pointer' }}
      >
        {t('onb.share.done')}
      </button>

    </WfBody>
  );
}

// clipboard write moved to shared components/CopyButton.tsx

/* ─── O3 — Join (verbatim port of OnbV3) ───────────────── */
function JoinStep({
  initialCode,
  onBack,
  onSubmit,
  error,
}: {
  initialCode?: string;
  onBack: () => void;
  onSubmit: (code: string) => Promise<unknown>;
  error: ApiError | null;
}) {
  const t = useT();
  const [code, setCode] = useState((initialCode ?? '').toUpperCase().padEnd(INVITE_CODE_LEN, ' '));
  const codeChars = padCode(code);
  const filledCode = codeChars.join('').trim();
  const [busy, setBusy] = useState(false);

  const peekQuery = useQuery({
    queryKey: ['peek', filledCode],
    queryFn: () => api.peekFamily(filledCode),
    enabled: filledCode.length >= 4,
    retry: false,
  });

  const submit = async () => {
    if (filledCode.length < 4) return;
    setBusy(true);
    try {
      await onSubmit(filledCode);
    } finally {
      setBusy(false);
    }
  };

  return (
    <WfBody>
      <div className="wf-row wf-gap-8">
        <button
          onClick={onBack}
          aria-label={t('common.back')}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--ink)' }}
        >
          <Icon name="chevL" />
        </button>
        <span className="wf-h2" style={{ flex: 1 }}>
          {t('onb.join.title')}
        </span>
      </div>

      <span className="wf-hint">{t('onb.join.hint')}</span>

      <CodeInput value={code} onChange={setCode} />
      <span className="wf-tiny">{t('onb.join.linkHint')}</span>

      {peekQuery.data && <FamilyPreview data={peekQuery.data} />}
      {peekQuery.error && (peekQuery.error as ApiError).status === 404 && (
        <div className="wf-card subtle" style={{ marginTop: 14 }}>
          <span className="wf-hint">{t('onb.join.notFound')}</span>
        </div>
      )}

      {error && (
        <div
          className="wf-card"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
        >
          {describeError(error, t)}
        </div>
      )}

      <button
        className="wf-btn primary lg block sticky-bottom"
        onClick={() => void submit()}
        disabled={busy || filledCode.length < 4}
        style={{
          cursor: busy || filledCode.length < 4 ? 'default' : 'pointer',
          opacity: busy || filledCode.length < 4 ? 0.5 : 1,
        }}
      >
        {busy ? t('onb.join.submitting') : t('onb.join.submit')}
      </button>
    </WfBody>
  );
}

function CodeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const chars = padCode(value);
  const inputRefs = useRefArray(INVITE_CODE_LEN);
  useEffect(() => {
    const firstEmpty = chars.findIndex((c) => !c.trim());
    const idx = firstEmpty === -1 ? INVITE_CODE_LEN - 1 : firstEmpty;
    inputRefs[idx]?.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="wf-row wf-gap-4" style={{ alignItems: 'stretch' }}>
      {chars.map((ch, i) => (
        <input
          key={i}
          ref={inputRefs[i]}
          value={ch.trim()}
          onChange={(e) => {
            const v = e.target.value.toUpperCase().slice(-1);
            const next = chars.slice();
            next[i] = v || ' ';
            onChange(next.join(''));
            if (v && i < INVITE_CODE_LEN - 1) inputRefs[i + 1]?.current?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !chars[i]?.trim() && i > 0) {
              inputRefs[i - 1]?.current?.focus();
            }
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData
              .getData('text')
              .toUpperCase()
              .replace(/\s/g, '')
              .slice(0, INVITE_CODE_LEN);
            if (pasted.length > 1) {
              e.preventDefault();
              onChange(pasted.padEnd(INVITE_CODE_LEN, ' '));
              inputRefs[Math.min(pasted.length, INVITE_CODE_LEN - 1)]?.current?.focus();
            }
          }}
          className="wf-box"
          maxLength={1}
          style={{
            width: 44,
            height: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            fontWeight: 700,
            fontSize: 22,
            textAlign: 'center',
            padding: 0,
            background: 'var(--paper)',
            color: 'var(--ink)',
            outline: 'none',
          }}
        />
      ))}
    </div>
  );
}

function FamilyPreview({
  data,
}: {
  data: {
    family: { id: string; name: string; createdAt: string; memberCount: number };
    owner: { id: string; firstName: string; color: string } | null;
    members: Array<{ id: string; firstName: string; color: string }>;
  };
}) {
  const otherMembers: Member[] = data.members
    .filter((m) => m.id !== data.owner?.id)
    .map((m) => ({
      id: m.id,
      name: m.firstName,
      letter: m.firstName.slice(0, 1).toUpperCase(),
      color: m.color,
      role: 'Adult',
    }));
  const ownerMember: Member | null = data.owner
    ? {
        id: data.owner.id,
        name: data.owner.firstName,
        letter: data.owner.firstName.slice(0, 1).toUpperCase(),
        color: data.owner.color,
        role: 'Owner',
      }
    : null;
  const createdAt = new Date(data.family.createdAt);

  const t = useT();
  const isEn = t.locale === 'en';
  return (
    <div className="wf-card elevated" style={{ marginTop: 14 }}>
      <span className="wf-hint">{t('onb.preview.willJoin')}</span>
      <div className="wf-row wf-gap-10" style={{ marginTop: 6 }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            background: 'var(--faint)',
            border: '1.5px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 26,
          }}
        >
          🏠
        </div>
        <div className="wf-col" style={{ flex: 1 }}>
          <span className="wf-h3">{data.family.name}</span>
          <span className="wf-hint">
            {t('onb.preview.since')}{' '}
            {isEn
              ? `${monthGen(createdAt.getMonth(), isEn)} ${createdAt.getDate()}`
              : `${createdAt.getDate()} ${monthGen(createdAt.getMonth(), isEn)}`}
            {' · '}
            {data.family.memberCount} {pluralPeople(data.family.memberCount, isEn)}
          </span>
        </div>
      </div>
      {ownerMember && (
        <div className="wf-row wf-gap-6" style={{ marginTop: 10 }}>
          <Av m={ownerMember} size="sm" />
          <span className="wf-label" style={{ flex: 1 }}>
            {ownerMember.name} <span className="wf-hint">{t('onb.preview.owner')}</span>
          </span>
          <Tag>Owner</Tag>
        </div>
      )}
      {otherMembers.length > 0 && (
        <div className="wf-row wf-gap-6">
          <AvStack members={otherMembers} size="sm" />
          <span className="wf-tiny">+ {otherMembers.map((m) => m.name).join(', ')}</span>
        </div>
      )}
    </div>
  );
}

function describeError(err: ApiError, t: TFn): string {
  const body = err.body as { error?: string } | null;
  switch (body?.error) {
    case 'not_found':
      return t('onb.join.notFound');
    case 'already_member':
      return t('onb.err.alreadyMember');
    case 'invalid_init_data':
      return t('onb.err.invalidTg');
    default:
      return err.message;
  }
}

/** Length of invite codes generated by the API (see customAlphabet(8) in families service). */
const INVITE_CODE_LEN = 8;

function padCode(v: string): string[] {
  const chars: string[] = [];
  for (let i = 0; i < INVITE_CODE_LEN; i++) chars.push(v[i] ?? ' ');
  return chars;
}

function monthGen(m: number, isEn = false): string {
  const ru = [
    'Янв',
    'Фев',
    'Мар',
    'Апр',
    'Май',
    'Июн',
    'Июл',
    'Авг',
    'Сен',
    'Окт',
    'Ноя',
    'Дек',
  ];
  const en = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return (isEn ? en : ru)[m] ?? '';
}

function pluralPeople(n: number, isEn = false): string {
  if (isEn) return n === 1 ? 'person' : 'people';
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'человек';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'человека';
  return 'человек';
}

import { createRef, useRef, type RefObject } from 'react';
function useRefArray(n: number): Array<RefObject<HTMLInputElement>> {
  const ref = useRef<Array<RefObject<HTMLInputElement>>>([]);
  if (ref.current.length !== n) {
    ref.current = Array.from({ length: n }, () => createRef<HTMLInputElement>()) as Array<
      RefObject<HTMLInputElement>
    >;
  }
  return ref.current;
}
