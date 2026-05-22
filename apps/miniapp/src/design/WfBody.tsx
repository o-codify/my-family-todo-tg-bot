import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';

type Props = {
  children: ReactNode;
  style?: CSSProperties;
  /**
   * Persist the scroll position of this body under a stable key across
   * mount/unmount cycles. When the user navigates away from a tab and
   * back, the scroller restores to wherever they were instead of jumping
   * to the top. Pass a key per logical screen (e.g. `'profile'`).
   */
  scrollKey?: string;
  /**
   * Called when the user swipes right from the left edge of the screen
   * past the activation threshold — typical "go back" gesture. If not
   * provided, the edge gesture is inert (top-level tabs).
   */
  onBack?: () => void;
  /**
   * Called when the user pulls down from the top of the scroller past
   * the activation threshold. Defaults to invalidating all TanStack
   * Query caches, which causes every visible query to refetch.
   */
  onRefresh?: () => void | Promise<void>;
};

/**
 * Module-level cache of last-known scroll positions, keyed by `scrollKey`.
 * In memory only — refresh / reload resets to 0.
 */
const scrollCache = new Map<string, number>();
const RESTORE_WINDOW_MS = 1500;

// Gesture thresholds — px to start tracking, px to commit.
const EDGE_ZONE_PX = 24;            // touchstart within this many px of left edge
const ACTIVATE_PX = 16;             // movement needed to lock a direction
const COMMIT_PX_BACK = 90;          // dx to trigger onBack
const COMMIT_PX_REFRESH = 70;       // dy to trigger onRefresh
const MAX_PULL_PX = 140;            // hard cap on visual indicator travel

export function WfBody({
  children,
  style,
  scrollKey,
  onBack,
  onRefresh,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();

  // Visual indicator state. We render a small circular chevron pill that
  // slides in from the edge the gesture is coming from. Same look for
  // both back and refresh so the user has one mental model.
  const [gesture, setGesture] = useState<null | 'back' | 'refresh'>(null);
  const [progress, setProgress] = useState(0);
  const [committed, setCommitted] = useState(false);
  // Mirror in a ref so the touch handler reads the latest value without
  // forcing the effect to re-subscribe mid-gesture (which would lose the
  // touchstart anchors and break the in-progress drag).
  const committedRef = useRef(false);
  useEffect(() => {
    committedRef.current = committed;
  }, [committed]);

  // ── Scroll restoration (unchanged from earlier) ───────────────────────
  useLayoutEffect(() => {
    if (!scrollKey) return;
    const el = ref.current;
    if (!el) return;
    const saved = scrollCache.get(scrollKey);
    if (saved == null || saved === 0) return;
    el.scrollTop = saved;
    let userInteracted = false;
    let timedOut = false;
    const tryRestore = () => {
      if (userInteracted || timedOut) return;
      const max = el.scrollHeight - el.clientHeight;
      const target = Math.min(saved, max);
      if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target;
      if (max >= saved) ro.disconnect();
    };
    const onUserScroll = () => {
      userInteracted = true;
      ro.disconnect();
    };
    const ro = new ResizeObserver(tryRestore);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    el.addEventListener('wheel', onUserScroll, { passive: true });
    el.addEventListener('touchmove', onUserScroll, { passive: true });
    const watchdog = setTimeout(() => {
      timedOut = true;
      ro.disconnect();
    }, RESTORE_WINDOW_MS);
    return () => {
      ro.disconnect();
      clearTimeout(watchdog);
      el.removeEventListener('wheel', onUserScroll);
      el.removeEventListener('touchmove', onUserScroll);
      scrollCache.set(scrollKey, el.scrollTop);
    };
  }, [scrollKey]);

  // Save scroll position on every frame the user scrolls.
  useEffect(() => {
    if (!scrollKey) return;
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        scrollCache.set(scrollKey, el.scrollTop);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollKey]);

  // ── Gesture: edge-swipe-back + pull-to-refresh ────────────────────────
  // Both gestures live on the same touch handler so we can disambiguate
  // direction at runtime (the user's intent isn't known until they've
  // moved past ACTIVATE_PX in the dominant axis).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let active: null | 'back' | 'refresh' = null;
    let startX = 0;
    let startY = 0;
    let startScroll = 0;

    const reset = () => {
      active = null;
      setGesture(null);
      setProgress(0);
      setCommitted(false);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return reset();
      const t = e.touches[0]!;
      startX = t.clientX;
      startY = t.clientY;
      startScroll = el.scrollTop;
      active = null;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0]!;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);

      if (!active) {
        // Edge swipe → back. Must originate near the left edge, move
        // right, and be mostly horizontal.
        if (onBack && startX < EDGE_ZONE_PX && dx > ACTIVATE_PX && adx > ady) {
          active = 'back';
        }
        // Pull → refresh. Must be at the top of the scroller, moving
        // down, and mostly vertical.
        else if (
          (onRefresh || true) &&
          startScroll <= 0 &&
          dy > ACTIVATE_PX &&
          ady > adx
        ) {
          active = 'refresh';
        } else {
          // No gesture committed yet — let normal scrolling happen.
          return;
        }
      }

      if (active === 'back') {
        const p = Math.min(Math.max(dx, 0) / COMMIT_PX_BACK, 1);
        setGesture('back');
        setProgress(p);
        setCommitted(dx >= COMMIT_PX_BACK);
        // Don't fight the browser only after we've committed to this
        // gesture — otherwise we'd block legitimate horizontal scroll.
        e.preventDefault();
      } else if (active === 'refresh') {
        const dyClamped = Math.min(Math.max(dy, 0), MAX_PULL_PX);
        const p = Math.min(dyClamped / COMMIT_PX_REFRESH, 1);
        setGesture('refresh');
        setProgress(p);
        setCommitted(dy >= COMMIT_PX_REFRESH);
        // Same here — preventDefault only inside the active refresh
        // gesture stops native pull-to-refresh while leaving normal
        // scroll alone.
        e.preventDefault();
      }
    };

    const onTouchEnd = async () => {
      if (active === 'back' && committedRef.current && onBack) {
        onBack();
      } else if (active === 'refresh' && committedRef.current) {
        try {
          if (onRefresh) {
            await onRefresh();
          } else {
            // Default: refetch everything visible.
            await queryClient.invalidateQueries();
          }
        } catch {
          /* swallow — user just wanted to retry */
        }
      }
      reset();
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', reset);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', reset);
    };
  }, [onBack, onRefresh, queryClient]);

  return (
    <div ref={ref} className="wf-body" style={style}>
      {/* Gesture indicator. Shared visual: a circular pill with a chevron-
          left arrow, color-flipped once the user passes the commit
          threshold (mirrors the iOS pattern where the indicator "fills"
          when the action will fire on release). */}
      {gesture && (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            zIndex: 50,
            width: 44,
            height: 44,
            borderRadius: 999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: committed ? 'var(--ink)' : 'var(--paper)',
            color: committed ? 'var(--paper)' : 'var(--ink)',
            border: '1.5px solid var(--line)',
            boxShadow: '0 2px 12px rgba(0,0,0,.12)',
            opacity: Math.max(progress, 0.4),
            transition: 'background .12s ease, color .12s ease',
            pointerEvents: 'none',
            ...(gesture === 'back'
              ? {
                  // Slide in from the left edge as the finger moves right.
                  top: '50%',
                  left: 0,
                  transform: `translate(${4 + progress * 48}px, -50%)`,
                }
              : {
                  // Slide down from the top center as the finger pulls.
                  top: 0,
                  left: '50%',
                  transform: `translate(-50%, ${4 + progress * 56}px) rotate(${gesture === 'refresh' ? progress * 270 : 0}deg)`,
                }),
          }}
        >
          {/* Same chevron-left glyph for both — the rotation on refresh
              makes it read as a circular "refresh" arc when committed. */}
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 6 9 12 15 18" />
          </svg>
        </div>
      )}
      {children}
    </div>
  );
}
