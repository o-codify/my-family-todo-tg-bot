import { type ReactNode, useState } from 'react';
import type { NotificationSettings } from '../api';
import { Icon } from '../design';
import { BottomSheet } from './BottomSheet';
import { type Locale, type TFn } from '../i18n';

/**
 * The small bottom-sheet pickers that drive the user's notification
 * preferences and language. They used to live inside Profile.tsx but
 * moved here when we split family-wide "Настройки" from personal "Мой
 * профиль" — both surfaces consumed the same sheet scaffolding, and
 * keeping them with `useT()`+`MeResponse` was bloating Profile.tsx.
 *
 * Each picker is its own component:
 *  - DigestPicker      — morning digest toggle + time grid
 *  - ReminderPicker    — default minutes-before-task notification
 *  - QuietHoursPicker  — start/end window when reminders are suppressed
 *  - LanguagePicker    — RU/EN
 *
 * They all share `SettingsSheet` (the common header + footer chrome) and
 * `MiniToggle` (the visual toggle). Both are private to this file.
 */

/** Common chrome — title, optional hint, close button, save/cancel footer.
 *  Exported so other family-management sheets (rename family, member
 *  actions) can reuse the same shell without duplicating it. */
export function SettingsSheet({
  title,
  hint,
  onClose,
  children,
  footer,
}: {
  title: string;
  hint?: string;
  onClose: () => void;
  children: (api: { close: (after?: () => void) => void }) => ReactNode;
  footer?: (api: { close: (after?: () => void) => void }) => ReactNode;
}) {
  return (
    <BottomSheet onClose={onClose} zIndex={12} title={title} subtitle={hint}>
      {({ close }) => (
        <>
          {children({ close })}
          {footer && <div style={{ marginTop: 12 }}>{footer({ close })}</div>}
        </>
      )}
    </BottomSheet>
  );
}

function MiniToggle({ on }: { on: boolean }) {
  return (
    <span
      style={{
        width: 32,
        height: 18,
        background: on ? 'var(--ink)' : 'var(--softline)',
        borderRadius: 999,
        position: 'relative',
        flex: 'none',
        display: 'inline-block',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: on ? 16 : 2,
          top: 2,
          width: 14,
          height: 14,
          borderRadius: 999,
          background: 'var(--paper)',
          transition: 'left 0.15s ease',
        }}
      />
    </span>
  );
}

/** "Утренний дайджест" — toggle + time grid (every 30 min from 06:00 to 12:00). */
export function DigestPicker({
  t,
  settings,
  onClose,
  onSave,
}: {
  t: TFn;
  settings: NotificationSettings;
  onClose: () => void;
  onSave: (patch: Partial<NotificationSettings>) => void;
}) {
  const [enabled, setEnabled] = useState(settings.digestEnabled);
  const [time, setTime] = useState(settings.digestTime);
  const TIMES = ['06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '11:00', '12:00'];
  return (
    <SettingsSheet
      title={t('notif.digest.title')}
      hint={t('notif.digest.hint')}
      onClose={onClose}
      footer={({ close }) => (
        <div className="wf-row wf-gap-8">
          <button className="wf-btn" onClick={() => close()} style={{ cursor: 'pointer' }}>
            {t('common.cancel')}
          </button>
          <button
            className="wf-btn primary"
            style={{ flex: 1, cursor: 'pointer' }}
            onClick={() => close(() => onSave({ digestEnabled: enabled, digestTime: time }))}
          >
            {t('common.save')}
          </button>
        </div>
      )}
    >
      {() => (
        <>
          <div className="wf-card" style={{ marginBottom: 8 }}>
            <div className="wf-spread" onClick={() => setEnabled(!enabled)} style={{ cursor: 'pointer' }}>
              <span className="wf-label">{t('notif.digest.title')}</span>
              <MiniToggle on={enabled} />
            </div>
          </div>
          {enabled && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {TIMES.map((tt) => (
                <span
                  key={tt}
                  onClick={() => setTime(tt)}
                  className={'wf-tag' + (tt === time ? ' solid' : '')}
                  style={{ cursor: 'pointer', justifyContent: 'center' }}
                >
                  {tt}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </SettingsSheet>
  );
}

/** "Напоминание перед задачей" — multi-select chip grid. Each chip is
 *  an interval ("за 60 мин", "за 15 мин", "за 5 мин"); tapping toggles
 *  membership. The saved value is `reminderIntervalsMinutes: number[]`.
 *  Empty array means "no reminders". A "—" chip clears all in one tap. */
export function ReminderPicker({
  t,
  settings,
  onClose,
  onSave,
}: {
  t: TFn;
  settings: NotificationSettings;
  onClose: () => void;
  onSave: (patch: Partial<NotificationSettings>) => void;
}) {
  const OPTIONS = [5, 10, 15, 30, 60, 120, 240, 1440];
  // Back-compat: legacy accounts only have `defaultReminderBeforeMinutes`;
  // surface that as a single-element initial selection so a save preserves
  // it as the new array shape.
  const initial =
    settings.reminderIntervalsMinutes ??
    (settings.defaultReminderBeforeMinutes > 0
      ? [settings.defaultReminderBeforeMinutes]
      : []);
  const [picked, setPicked] = useState<number[]>(initial);
  const toggle = (m: number) =>
    setPicked((curr) =>
      curr.includes(m) ? curr.filter((x) => x !== m) : [...curr, m].sort((a, b) => a - b),
    );
  return (
    <SettingsSheet
      title={t('notif.reminder.title')}
      hint={t('notif.reminder.hint')}
      onClose={onClose}
      footer={({ close }) => (
        <div className="wf-row wf-gap-8">
          <button className="wf-btn" onClick={() => close()} style={{ cursor: 'pointer' }}>
            {t('common.cancel')}
          </button>
          <button
            className="wf-btn primary"
            style={{ flex: 1, cursor: 'pointer' }}
            onClick={() =>
              close(() =>
                onSave({
                  reminderIntervalsMinutes: picked,
                  // Mirror to the legacy field too — keeps any consumer that
                  // still reads `defaultReminderBeforeMinutes` (e.g. older
                  // bot copy) sensible. First selected interval is a fine
                  // proxy; 0 when empty disables there as well.
                  defaultReminderBeforeMinutes: picked[0] ?? 0,
                }),
              )
            }
          >
            {t('common.save')}
          </button>
        </div>
      )}
    >
      {() => (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          <span
            onClick={() => setPicked([])}
            className={'wf-tag' + (picked.length === 0 ? ' solid' : '')}
            style={{ cursor: 'pointer', justifyContent: 'center' }}
          >
            —
          </span>
          {OPTIONS.map((m) => (
            <span
              key={m}
              onClick={() => toggle(m)}
              className={'wf-tag' + (picked.includes(m) ? ' solid' : '')}
              style={{ cursor: 'pointer', justifyContent: 'center' }}
            >
              {m === 1440
                ? t('notif.reminder.day')
                : `${m} ${t('profile.notifications.reminder.value')}`}
            </span>
          ))}
        </div>
      )}
    </SettingsSheet>
  );
}

/** "Тихие часы" — start/end HH:MM inputs + enable toggle. */
export function QuietHoursPicker({
  t,
  settings,
  onClose,
  onSave,
}: {
  t: TFn;
  settings: NotificationSettings;
  onClose: () => void;
  onSave: (patch: Partial<NotificationSettings>) => void;
}) {
  const [enabled, setEnabled] = useState(!!(settings.quietHoursStart && settings.quietHoursEnd));
  const [start, setStart] = useState(settings.quietHoursStart ?? '22:00');
  const [end, setEnd] = useState(settings.quietHoursEnd ?? '08:00');
  return (
    <SettingsSheet
      title={t('notif.quietHours.title')}
      hint={t('notif.quietHours.hint')}
      onClose={onClose}
      footer={({ close }) => (
        <div className="wf-row wf-gap-8">
          <button className="wf-btn" onClick={() => close()} style={{ cursor: 'pointer' }}>
            {t('common.cancel')}
          </button>
          <button
            className="wf-btn primary"
            style={{ flex: 1, cursor: 'pointer' }}
            onClick={() =>
              close(() =>
                onSave(
                  enabled
                    ? { quietHoursStart: start, quietHoursEnd: end }
                    : { quietHoursStart: null, quietHoursEnd: null },
                ),
              )
            }
          >
            {t('common.save')}
          </button>
        </div>
      )}
    >
      {() => (
        <>
          <div className="wf-card" style={{ marginBottom: 8 }}>
            <div
              className="wf-spread"
              onClick={() => setEnabled(!enabled)}
              style={{ cursor: 'pointer' }}
            >
              <span className="wf-label">{t('notif.quietHours.enable')}</span>
              <MiniToggle on={enabled} />
            </div>
          </div>
          {enabled && (
            <div className="wf-row wf-gap-8">
              <div className="wf-col wf-gap-2" style={{ flex: 1 }}>
                <span className="wf-tiny">{t('notif.quietHours.start')}</span>
                <div className="wf-box" style={{ padding: '8px 10px' }}>
                  <input
                    type="time"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                    className="wf-label"
                    style={{
                      width: '100%',
                      border: 'none',
                      background: 'transparent',
                      outline: 'none',
                      color: 'var(--ink)',
                      font: 'inherit',
                    }}
                  />
                </div>
              </div>
              <div className="wf-col wf-gap-2" style={{ flex: 1 }}>
                <span className="wf-tiny">{t('notif.quietHours.end')}</span>
                <div className="wf-box" style={{ padding: '8px 10px' }}>
                  <input
                    type="time"
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                    className="wf-label"
                    style={{
                      width: '100%',
                      border: 'none',
                      background: 'transparent',
                      outline: 'none',
                      color: 'var(--ink)',
                      font: 'inherit',
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </SettingsSheet>
  );
}

/** Language picker — 2 options for now (RU/EN). Extend `Locale` to add more. */
export function LanguagePicker({
  t,
  current,
  onClose,
  onPick,
}: {
  t: TFn;
  current: Locale;
  onClose: () => void;
  onPick: (loc: Locale) => void;
}) {
  const OPTIONS: { id: Locale; label: string; native: string }[] = [
    { id: 'ru', label: t('language.ru'), native: 'Русский' },
    { id: 'en', label: t('language.en'), native: 'English' },
  ];
  return (
    <SettingsSheet title={t('language.picker.title')} onClose={onClose}>
      {({ close }) =>
        OPTIONS.map((opt) => {
          const isCurrent = opt.id === current;
          return (
            <div
              key={opt.id}
              className="wf-card compact"
              onClick={() => close(() => onPick(opt.id))}
              style={{ cursor: 'pointer', marginBottom: 4 }}
            >
              <div className="wf-spread">
                <span className="wf-label">{opt.native}</span>
                {isCurrent && (
                  <span style={{ color: 'var(--success)' }}>
                    <Icon name="check" />
                  </span>
                )}
              </div>
            </div>
          );
        })
      }
    </SettingsSheet>
  );
}
