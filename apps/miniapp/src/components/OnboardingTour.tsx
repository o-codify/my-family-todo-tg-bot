import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';

/**
 * 5-step "first time here" tour shown to new family members. We don't try
 * to highlight specific DOM elements with arrows/cutouts — the burger drawer
 * + small viewports make that fragile — instead we explain each destination
 * with a paragraph and tell the user where to find it. This lands the same
 * value (orientation) without depending on layout.
 *
 * Triggering: `<FamilyHome>` mounts the tour once when `preferences.viewedTour`
 * is missing/false. Completing or skipping flips the flag.
 */
export type TourStep = {
  titleKey: string;
  bodyKey: string;
};

const STEPS: TourStep[] = [
  { titleKey: 'tour.step.create.title', bodyKey: 'tour.step.create.body' },
  { titleKey: 'tour.step.invite.title', bodyKey: 'tour.step.invite.body' },
  { titleKey: 'tour.step.queues.title', bodyKey: 'tour.step.queues.body' },
  { titleKey: 'tour.step.shop.title', bodyKey: 'tour.step.shop.body' },
  { titleKey: 'tour.step.settings.title', bodyKey: 'tour.step.settings.body' },
];

// Stable dialog dimensions — the dialog should *not* visually grow/shrink
// as the user steps through, otherwise the surrounding faded UI shifts and
// the buttons jump under the thumb. We size to fit the longest body line
// at the mini-app's standard ~360 px width.
const DIALOG_WIDTH = 320;
const TITLE_MIN_HEIGHT = 28;
const BODY_MIN_HEIGHT = 110;

type Props = {
  /** Called when the user finishes the last step or taps "Пропустить".
   *  Caller is responsible for persisting the dismissal (typically by
   *  PATCHing `preferences.viewedTour=true`). */
  onClose: () => void;
};

export function OnboardingTour({ onClose }: Props) {
  const t = useT();
  const [idx, setIdx] = useState(0);
  const isFirst = idx === 0;
  const isLast = idx === STEPS.length - 1;
  const step = STEPS[idx]!;

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="wf-card"
        style={{
          // Fixed width + min-heights on title/body keep the card from
          // resizing as the user steps through. No scroll: the body slots
          // are large enough for the longest copy at this width.
          width: DIALOG_WIDTH,
          maxWidth: 'calc(100vw - 32px)',
          background: 'var(--paper)',
          padding: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {/* Step pips so the user knows how much is left. */}
        <div className="wf-row wf-gap-6" style={{ justifyContent: 'center' }}>
          {STEPS.map((_, i) => (
            <span
              key={i}
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: i === idx ? 'var(--ink)' : 'var(--softline)',
              }}
            />
          ))}
        </div>

        <span
          className="wf-h2"
          style={{ marginTop: 4, minHeight: TITLE_MIN_HEIGHT }}
        >
          {t(step.titleKey)}
        </span>
        <span
          className="wf-body-text"
          style={{
            color: 'var(--ink)',
            lineHeight: 1.4,
            minHeight: BODY_MIN_HEIGHT,
            // Word-wrap so a single long word doesn't blow the fixed width.
            overflowWrap: 'anywhere',
          }}
        >
          {t(step.bodyKey)}
        </span>

        {/* Actions row. Left side: Back when there's a previous step, else
            Skip. We keep both buttons at the same baseline so the primary
            "Next/Done" never jumps horizontally between steps. */}
        <div className="wf-row wf-gap-8" style={{ marginTop: 8 }}>
          {isFirst ? (
            <button
              type="button"
              className="wf-btn ghost"
              onClick={onClose}
              style={{ cursor: 'pointer' }}
            >
              {t('tour.skip')}
            </button>
          ) : (
            <button
              type="button"
              className="wf-btn ghost"
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              style={{ cursor: 'pointer' }}
            >
              {t('tour.back')}
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="wf-btn primary"
            onClick={() => {
              if (isLast) onClose();
              else setIdx((i) => i + 1);
            }}
            style={{ cursor: 'pointer' }}
          >
            {isLast ? t('tour.done') : t('tour.next')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
