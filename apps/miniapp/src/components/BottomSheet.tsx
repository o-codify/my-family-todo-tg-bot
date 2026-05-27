import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../design';

export type SheetCloseFn = (after?: () => void) => void;

type Props = {
  /** Final cleanup — runs after the slide-out animation completes. */
  onClose: () => void;
  zIndex?: number;
  /** Sticky title rendered in the pinned header row. Required so every
   *  sheet across the app gets the same affordance: drag handle + title
   *  + close (✕). */
  title: ReactNode;
  /** Optional small text shown right under the title — also sticky.
   *  Use sparingly; for longer explanations put a `wf-hint` inside the
   *  body instead. */
  subtitle?: ReactNode;
  /** Optional extra header buttons rendered to the LEFT of the built-in
   *  close button (e.g. a pencil-edit shortcut on TaskSheet). */
  headerActions?: (api: { close: SheetCloseFn }) => ReactNode;
  /** Aria-label for the close button. Falls back to "Close" — set this
   *  to the localized string when you want the screen reader to read it
   *  in the user's language. */
  closeAriaLabel?: string;
  /** Render-prop: receives a `close()` helper that plays the exit animation
   *  before invoking the supplied callback (or the parent's `onClose` if no
   *  callback is passed). Use this in place of the old direct `onClose()`
   *  calls so the sheet animates out instead of vanishing. */
  children: (api: { close: SheetCloseFn }) => ReactNode;
};

/**
 * Animated bottom sheet shell — the single component every sheet in the
 * app should use.
 *
 * Layout (top → bottom, always identical):
 *   1. Drag handle (sticky)
 *   2. Title row: title text + optional `headerActions` + built-in ✕ (sticky)
 *   3. Optional subtitle (sticky)
 *   4. Scrollable body (children)
 *
 * Mount triggers a slide-up + backdrop-fade-in (CSS keyframes).
 * `close()` flips the `is-closing` class so the inverse animation plays,
 * then calls the parent's `onClose` after `ANIM_MS` ms — only then does the
 * parent actually unmount the sheet, which keeps the exit animation visible.
 *
 * The `close` helper also accepts an `after` callback for side-effect closes
 * (e.g. TaskSheet's "Edit" or "Transfer" buttons that open *another* sheet):
 * `close(onTransfer)` plays the exit animation, then runs `onTransfer()`
 * which both clears this sheet's state and sets the next sheet's state.
 */
const ANIM_MS = 240;

export function BottomSheet({
  onClose,
  zIndex = 10,
  title,
  subtitle,
  headerActions,
  closeAriaLabel,
  children,
}: Props) {
  const [closing, setClosing] = useState(false);
  const closedRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  const close = useCallback<SheetCloseFn>(
    (after) => {
      if (closedRef.current) return;
      closedRef.current = true;
      setClosing(true);
      timerRef.current = window.setTimeout(() => {
        if (after) after();
        else onClose();
      }, ANIM_MS);
    },
    [onClose],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  // Portal into <body> so the sheet escapes any stacking context created
  // by ancestors (`.wf-body` has `position: relative`, `#root` is a flex
  // column with `overflow: hidden` — both can constrain a child's z-index
  // and let the bottom-nav paint on top of the sheet despite higher z).
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      onClick={() => close()}
      className={'wf-sheet-backdrop' + (closing ? ' is-closing' : '')}
      style={{ zIndex }}
    >
      {/* Two-layer scroll containment:
          - outer `.wf-sheet` is a flex column capped at 90vh with NO
            scrolling — that anchors the sticky chrome (handle + title)
            to the top of the panel;
          - inner `.wf-sheet__scroll` is the actual scroll surface.
          We strip `.wf-sheet`'s legacy `padding: 12px 14px 20px` here
          and reapply matching insets on the sticky header + body so
          they line up exactly the way they did when sheets handled
          padding themselves. */}
      <div
        className={'wf-sheet wf-sheet--animated' + (closing ? ' is-closing' : '')}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'static',
          maxHeight: '90vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          padding: 0,
        }}
      >
        {/* Sticky chrome — handle + title row + optional subtitle. Never
            scrolls, so the affordance stays put no matter how long the
            body is. */}
        <div
          style={{
            flex: 'none',
            padding: '12px 14px 8px',
          }}
        >
          <div className="handle" aria-hidden style={{ marginBottom: 10 }} />
          <div className="wf-row wf-gap-8">
            <span className="wf-h2" style={{ flex: 1, minWidth: 0 }}>
              {title}
            </span>
            {headerActions?.({ close })}
            <button
              type="button"
              onClick={() => close()}
              aria-label={closeAriaLabel ?? 'Close'}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                color: 'var(--ink)',
                flex: 'none',
              }}
            >
              <Icon name="x" />
            </button>
          </div>
          {subtitle != null && (
            <span
              className="wf-hint"
              style={{ display: 'block', marginTop: 6 }}
            >
              {subtitle}
            </span>
          )}
        </div>
        <div
          className="wf-sheet__scroll"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '0 14px 20px',
          }}
        >
          {children({ close })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
