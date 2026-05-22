import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

type CloseFn = (after?: () => void) => void;

type Props = {
  /** Final cleanup — runs after the slide-out animation completes. */
  onClose: () => void;
  zIndex?: number;
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

export function BottomSheet({ onClose, zIndex = 10, children }: Props) {
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

  return (
    <div
      onClick={() => close()}
      className={'wf-sheet-backdrop' + (closing ? ' is-closing' : '')}
      style={{ zIndex }}
    >
      <div
        className={'wf-sheet wf-sheet--animated' + (closing ? ' is-closing' : '')}
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'static', maxHeight: '90vh', overflowY: 'auto', width: '100%' }}
      >
        {children({ close })}
      </div>
    </div>
  );
}
