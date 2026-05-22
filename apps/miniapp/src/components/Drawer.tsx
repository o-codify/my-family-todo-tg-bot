import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type CloseFn = (after?: () => void) => void;

type Props = {
  onClose: () => void;
  zIndex?: number;
  /** Render-prop receiving a `close()` helper that plays the slide-out
   *  animation before invoking the supplied callback (or the parent's
   *  `onClose`). Same shape as BottomSheet so callsites read the same. */
  children: (api: { close: CloseFn }) => ReactNode;
};

const ANIM_MS = 240;

/**
 * Left-slide-in drawer. Mirrors BottomSheet's animation pattern but anchors
 * to the left edge, taking ~84% of the viewport width up to a 320 px max so
 * a thin strip of content stays visible on the right (tap-to-dismiss zone).
 *
 * Used by the burger-menu navigation in FamilyHome.
 */
export function Drawer({ onClose, zIndex = 30, children }: Props) {
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

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      onClick={() => close()}
      className={'wf-drawer-backdrop' + (closing ? ' is-closing' : '')}
      style={{ zIndex }}
    >
      <aside
        className={'wf-drawer wf-drawer--animated' + (closing ? ' is-closing' : '')}
        onClick={(e) => e.stopPropagation()}
      >
        {children({ close })}
      </aside>
    </div>,
    document.body,
  );
}
