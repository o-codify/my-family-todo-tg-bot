import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type CloseFn = (after?: () => void) => void;

type Props = {
  /** Final cleanup — runs after the slide-out animation completes. */
  onClose: () => void;
  zIndex?: number;
  /** Optional sticky header — pinned above the scrollable body. Use
   *  for the sheet's title + close button so they don't scroll away.
   *  The drag handle is rendered automatically above this slot. */
  header?: (api: { close: CloseFn }) => ReactNode;
  /** Render-prop: receives a `close()` helper that plays the exit animation
   *  before invoking the supplied callback (or the parent's `onClose` if no
   *  callback is passed). Use this in place of the old direct `onClose()`
   *  calls so the sheet animates out instead of vanishing. */
  children: (api: { close: CloseFn }) => ReactNode;
};

/**
 * Animated bottom sheet shell.
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

export function BottomSheet({ onClose, zIndex = 10, header, children }: Props) {
  const [closing, setClosing] = useState(false);
  const closedRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  const close = useCallback<CloseFn>(
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
            scrolling — that anchors the visual top of the sheet so the
            handle + the consumer's first row (typically a title + close
            button) stay put as the user scrolls inside;
          - inner `.wf-sheet__scroll` is the actual scroll surface.
          We keep `wf-sheet` declaring overflow:auto in CSS for legacy
          consumers, so we explicitly null it out here. */}
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
        }}
      >
        {/* Drag handle — always at the top of the sheet, never
            scrolls. Consumers that previously rendered their own
            `<div className="handle" />` inside the body should drop
            it. */}
        <div
          className="handle"
          style={{ flex: 'none', marginTop: 6, marginBottom: 6 }}
          aria-hidden
        />
        {/* Sticky header slot. Lives above the scroll surface so the
            title + close button stay visible when the body scrolls.
            Padded to match the sheet's body inset. */}
        {header && (
          <div
            style={{
              flex: 'none',
              padding: '0 var(--gap, 12px) 8px',
            }}
          >
            {header({ close })}
          </div>
        )}
        <div
          className="wf-sheet__scroll"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            // Match the padding the .wf-sheet selector applied before —
            // the consumer's spacing was tuned for that. Keeping it on
            // the inner scroller lets the handle/title hug the top edge.
            padding: 'inherit',
          }}
        >
          {children({ close })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
