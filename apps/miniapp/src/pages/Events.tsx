import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type FamilyEventDto,
  type FamilyEventType,
  type FamilyMemberDto,
  type FamilySummary,
  type MeResponse,
} from '../api';
import { Icon, WfBody } from '../design';
import { BottomSheet } from '../components/BottomSheet';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { interpolate, useT, type TFn } from '../i18n';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  onBack?: () => void;
  onOpenDrawer?: () => void;
};

const TYPES: FamilyEventType[] = [
  'birthday',
  'anniversary',
  'nameday',
  'memorial',
  'custom',
];

const TYPE_EMOJI: Record<FamilyEventType, string> = {
  birthday: '🎂',
  anniversary: '💍',
  nameday: '✨',
  memorial: '🕯️',
  custom: '📅',
};

/**
 * Family events: birthdays, anniversaries, and free-form important dates.
 * Stored as yearly-recurring (month/day); "next occurrence" computed on
 * the client. We sort by days-until-next and group into buckets so the
 * user sees what's actually coming up.
 */
export function Events({ me, family, onBack, onOpenDrawer }: Props) {
  const t = useT();
  void me;
  const queryClient = useQueryClient();
  const toast = useToast();

  const eventsQuery = useQuery({
    queryKey: ['family-events', family.id],
    queryFn: () => api.listFamilyEvents(family.id),
  });
  const membersQuery = useQuery({
    queryKey: ['members', family.id],
    queryFn: () => api.listMembers(family.id),
  });

  const events = eventsQuery.data?.events ?? [];
  const members = membersQuery.data?.members ?? [];

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteFamilyEvent(family.id, id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['family-events', family.id] });
      toast.show({
        message: t('common.deleted'),
        variant: 'success',
        durationMs: 5000,
        action: {
          label: t('common.undo'),
          onClick: () => {
            api
              .restoreFamilyEvent(family.id, id)
              .then(() =>
                queryClient.invalidateQueries({ queryKey: ['family-events', family.id] }),
              )
              .catch(() =>
                toast.show({ message: t('common.restoreFailed'), variant: 'error' }),
              );
          },
        },
      });
    },
  });

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<FamilyEventDto | null>(null);

  // Group by upcoming window — this week, this month, later. The
  // computation depends on today's date, which is stable for the page
  // render; recompute on each render is cheap (events list is small).
  const buckets = useMemo(() => {
    const now = new Date();
    const decorated = events.map((e) => {
      const days = daysUntil(e.month, e.day, now);
      return { ev: e, days };
    });
    decorated.sort((a, b) => a.days - b.days);
    const thisWeek: typeof decorated = [];
    const thisMonth: typeof decorated = [];
    const later: typeof decorated = [];
    for (const d of decorated) {
      if (d.days <= 7) thisWeek.push(d);
      else if (d.days <= 31) thisMonth.push(d);
      else later.push(d);
    }
    return { thisWeek, thisMonth, later };
  }, [events]);

  return (
    <WfBody onBack={onBack}>
      <PageHeader
        title={t('events.title')}
        onBack={onBack}
        onOpenDrawer={onOpenDrawer}
        right={
          <button
            type="button"
            className="wf-btn primary"
            onClick={() => {
              setEditingEvent(null);
              setEditorOpen(true);
            }}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              cursor: 'pointer',
              border: 'none',
            }}
          >
            + {t('events.add')}
          </button>
        }
      />

      {eventsQuery.isLoading && <span className="wf-hint">{t('common.loading')}</span>}

      {!eventsQuery.isLoading && events.length === 0 && (
        <div className="wf-card subtle" style={{ textAlign: 'center', padding: 18 }}>
          <div style={{ fontSize: 36 }}>🎂</div>
          <span className="wf-h3" style={{ display: 'block', marginTop: 8 }}>
            {t('events.empty.title')}
          </span>
          <span className="wf-hint" style={{ display: 'block', marginTop: 4 }}>
            {t('events.empty.hint')}
          </span>
        </div>
      )}

      {buckets.thisWeek.length > 0 && (
        <Section title={t('events.section.thisWeek')}>
          {buckets.thisWeek.map(({ ev, days }) => (
            <EventRow
              key={ev.id}
              event={ev}
              days={days}
              members={members}
              onEdit={() => {
                setEditingEvent(ev);
                setEditorOpen(true);
              }}
              onDelete={() => deleteMut.mutate(ev.id)}
              t={t}
            />
          ))}
        </Section>
      )}

      {buckets.thisMonth.length > 0 && (
        <Section title={t('events.section.thisMonth')}>
          {buckets.thisMonth.map(({ ev, days }) => (
            <EventRow
              key={ev.id}
              event={ev}
              days={days}
              members={members}
              onEdit={() => {
                setEditingEvent(ev);
                setEditorOpen(true);
              }}
              onDelete={() => deleteMut.mutate(ev.id)}
              t={t}
            />
          ))}
        </Section>
      )}

      {buckets.later.length > 0 && (
        <Section title={t('events.section.later')}>
          {buckets.later.map(({ ev, days }) => (
            <EventRow
              key={ev.id}
              event={ev}
              days={days}
              members={members}
              onEdit={() => {
                setEditingEvent(ev);
                setEditorOpen(true);
              }}
              onDelete={() => deleteMut.mutate(ev.id)}
              t={t}
            />
          ))}
        </Section>
      )}

      {editorOpen && (
        <EventEditor
          familyId={family.id}
          members={members}
          existing={editingEvent}
          onClose={() => {
            setEditorOpen(false);
            setEditingEvent(null);
          }}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['family-events', family.id] });
            setEditorOpen(false);
            setEditingEvent(null);
          }}
          t={t}
        />
      )}
    </WfBody>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="wf-col" style={{ gap: 4 }}>
      <span className="wf-tiny" style={{ marginTop: 8 }}>
        {title}
      </span>
      {children}
    </div>
  );
}

function EventRow({
  event,
  days,
  members,
  onEdit,
  onDelete,
  t,
}: {
  event: FamilyEventDto;
  days: number;
  members: FamilyMemberDto[];
  onEdit: () => void;
  onDelete: () => void;
  t: TFn;
}) {
  const emoji = event.emoji ?? TYPE_EMOJI[event.type];
  const member = event.memberUserId
    ? members.find((m) => m.id === event.memberUserId)
    : null;
  const tint = member?.color ?? 'var(--faint)';
  const sub =
    days === 0
      ? t('events.today')
      : days === 1
        ? t('events.tomorrow')
        : interpolate(t('events.inNDays'), { n: days });

  // Age display: "turns 30" when year known.
  const age = (() => {
    if (event.year === null) return null;
    const next = nextOccurrence(event.month, event.day, new Date());
    return next.getUTCFullYear() - event.year;
  })();

  return (
    <div className="wf-card" style={{ padding: 10 }}>
      <div className="wf-row wf-gap-10" style={{ alignItems: 'center' }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            background: tint,
            border: '1.5px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 20,
            flex: 'none',
          }}
        >
          {emoji}
        </div>
        <div className="wf-col" style={{ flex: 1, minWidth: 0 }}>
          <span
            className="wf-label"
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {event.title}
            {age !== null && (
              <span className="wf-tiny" style={{ marginLeft: 6, color: 'var(--hint)' }}>
                · {t('events.turns')} {age}
              </span>
            )}
          </span>
          <span className="wf-tiny" style={{ color: 'var(--hint)' }}>
            {event.day} {t(`events.month.${event.month}`)} · {sub}
          </span>
        </div>
        <button
          type="button"
          onClick={onEdit}
          aria-label="edit"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--hint)',
            cursor: 'pointer',
            padding: 4,
            flex: 'none',
          }}
        >
          <Icon name="edit" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label="delete"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--hint)',
            cursor: 'pointer',
            padding: 4,
            flex: 'none',
          }}
        >
          <Icon name="x" />
        </button>
      </div>
    </div>
  );
}

const NOTIFY_OFFSETS = [0, 1, 3, 7, 30] as const;

function EventEditor({
  familyId,
  members,
  existing,
  onClose,
  onSaved,
  t,
}: {
  familyId: string;
  members: FamilyMemberDto[];
  existing: FamilyEventDto | null;
  onClose: () => void;
  onSaved: () => void;
  t: TFn;
}) {
  const [type, setType] = useState<FamilyEventType>(existing?.type ?? 'birthday');
  const [title, setTitle] = useState(existing?.title ?? '');
  const [emoji, setEmoji] = useState(existing?.emoji ?? '');
  const [month, setMonth] = useState(existing?.month ?? new Date().getMonth() + 1);
  const [day, setDay] = useState(existing?.day ?? new Date().getDate());
  const [year, setYear] = useState<number | ''>(existing?.year ?? '');
  const [memberUserId, setMemberUserId] = useState<string | null>(
    existing?.memberUserId ?? null,
  );
  const [notifyDaysBefore, setNotifyDaysBefore] = useState<number[]>(
    existing?.notifyDaysBefore ?? [0, 1, 7],
  );

  const createMut = useMutation({
    mutationFn: () =>
      api.createFamilyEvent(familyId, {
        type,
        title: title.trim() || (member?.firstName ?? t(`events.type.${type}`)),
        emoji: emoji.trim() || null,
        month,
        day,
        year: year === '' ? null : Number(year),
        memberUserId,
        notifyDaysBefore,
      }),
    onSuccess: onSaved,
  });
  const updateMut = useMutation({
    mutationFn: () =>
      api.updateFamilyEvent(familyId, existing!.id, {
        type,
        title: title.trim() || (member?.firstName ?? t(`events.type.${type}`)),
        emoji: emoji.trim() || null,
        month,
        day,
        year: year === '' ? null : Number(year),
        memberUserId,
        notifyDaysBefore,
      }),
    onSuccess: onSaved,
  });

  const member = memberUserId ? members.find((m) => m.id === memberUserId) : null;
  // When picking a member for a birthday, pre-fill the title with their
  // first name (only when the field is empty — never overwrite user input).
  const onPickMember = (id: string | null) => {
    setMemberUserId(id);
    if (id && title.trim() === '') {
      const m = members.find((mm) => mm.id === id);
      if (m) setTitle(m.firstName);
    }
  };

  const save = () => {
    if (existing) updateMut.mutate();
    else createMut.mutate();
  };

  const pending = createMut.isPending || updateMut.isPending;

  return (
    <BottomSheet onClose={onClose}>
      {({ close }) => (
        <>
          
          <div className="wf-col" style={{ gap: 10 }}>
            <span className="wf-h3">
              {existing ? t('events.field.title') : t('events.add')}
            </span>

          <Field label={t('events.field.type')}>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as FamilyEventType)}
              style={inputStyle}
            >
              {TYPES.map((tp) => (
                <option key={tp} value={tp}>
                  {TYPE_EMOJI[tp]} {t(`events.type.${tp}`)}
                </option>
              ))}
            </select>
          </Field>

          {members.length > 0 && (
            <Field label={t('events.field.member')}>
              <select
                value={memberUserId ?? ''}
                onChange={(e) => onPickMember(e.target.value || null)}
                style={inputStyle}
              >
                <option value="">{t('events.field.member.none')}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.firstName}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label={t('events.field.title')}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={member?.firstName ?? t(`events.type.${type}`)}
              style={inputStyle}
            />
          </Field>

          <Field label={t('events.field.emoji')}>
            <input
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              placeholder={TYPE_EMOJI[type]}
              maxLength={4}
              style={{ ...inputStyle, maxWidth: 120 }}
            />
          </Field>

          <div className="wf-row wf-gap-8">
            <Field label={t('events.field.month')}>
              <select
                value={month}
                onChange={(e) => setMonth(Number(e.target.value))}
                style={inputStyle}
              >
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>
                    {t(`events.month.${m}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('events.field.day')}>
              <select
                value={day}
                onChange={(e) => setDay(Number(e.target.value))}
                style={inputStyle}
              >
                {Array.from({ length: daysInMonth(month) }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label={t('events.field.year')}>
            <input
              value={year}
              onChange={(e) =>
                setYear(e.target.value === '' ? '' : Number(e.target.value))
              }
              type="number"
              placeholder="1990"
              style={{ ...inputStyle, maxWidth: 140 }}
            />
          </Field>

          <Field label={t('events.field.notify')}>
            <div className="wf-row wf-gap-6" style={{ flexWrap: 'wrap' }}>
              {NOTIFY_OFFSETS.map((n) => {
                const active = notifyDaysBefore.includes(n);
                return (
                  <button
                    key={n}
                    type="button"
                    className="wf-seg"
                    onClick={() =>
                      setNotifyDaysBefore((prev) =>
                        prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n].sort(),
                      )
                    }
                    // `.wf-seg.active` had no CSS rule (the design's Seg
                    // component uses `> span.on` for selection). Apply
                    // ink-on-paper inline so the chip clearly reflects
                    // its selected state — without this the user can't
                    // tell which offsets they picked.
                    style={{
                      fontSize: 12,
                      padding: '4px 10px',
                      cursor: 'pointer',
                      ...(active
                        ? {
                            background: 'var(--ink)',
                            color: 'var(--paper)',
                            borderColor: 'var(--ink)',
                          }
                        : null),
                    }}
                  >
                    {t(`events.notify.${n}`)}
                  </button>
                );
              })}
            </div>
          </Field>

            <div className="wf-row wf-gap-8" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="wf-btn"
                onClick={() => close()}
                style={{ flex: 1, cursor: 'pointer' }}
              >
                {t('events.cancel')}
              </button>
              <button
                type="button"
                className="wf-btn primary"
                disabled={pending}
                onClick={save}
                style={{
                  flex: 1,
                  cursor: pending ? 'default' : 'pointer',
                  border: 'none',
                }}
              >
                {t('events.save')}
              </button>
            </div>
          </div>
        </>
      )}
    </BottomSheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="wf-col" style={{ gap: 4 }}>
      <span className="wf-tiny">{label}</span>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  border: '1.5px solid var(--line)',
  borderRadius: 8,
  padding: '6px 10px',
  background: 'var(--paper)',
  font: 'inherit',
  color: 'var(--ink)',
  fontSize: 13,
};

// ─── helpers (duplicated client-side, kept in sync with services/events.ts) ─

function daysInMonth(month: number): number {
  // Use a non-leap year so Feb gets 29 — we just need the upper bound for
  // the picker, validation on the server prevents impossible dates.
  return new Date(Date.UTC(2024, month, 0)).getUTCDate();
}

function nextOccurrence(month: number, day: number, today: Date): Date {
  const year = today.getUTCFullYear();
  const candidate = makeDate(year, month, day);
  const todayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  if (candidate.getTime() < todayUtc) return makeDate(year + 1, month, day);
  return candidate;
}

function makeDate(year: number, month: number, day: number): Date {
  if (month === 2 && day === 29 && !isLeap(year)) {
    return new Date(Date.UTC(year, 1, 28));
  }
  return new Date(Date.UTC(year, month - 1, day));
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysUntil(month: number, day: number, today: Date): number {
  const next = nextOccurrence(month, day, today);
  const startOfToday = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  return Math.round((next.getTime() - startOfToday) / 86_400_000);
}
