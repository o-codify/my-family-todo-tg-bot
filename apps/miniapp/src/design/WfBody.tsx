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
  /** Persist this body's scroll across mount/unmount. */
  scrollKey?: string;
  /** Edge-swipe-right past threshold → fires this. Pass per sub-page. */
  onBack?: () => void;
  /** Pull-down from top past threshold → fires this. Defaults to
   *  invalidating all TanStack Query caches. */
  onRefresh?: () => void | Promise<void>;
};

const scrollCache = new Map<string, number>();
const RESTORE_WINDOW_MS = 1500;

// Gesture thresholds — px.
const EDGE_ZONE_PX = 24;
const ACTIVATE_PX = 16;
const COMMIT_PX_BACK = 90;
const COMMIT_PX_REFRESH = 70;
const MAX_PULL_PX = 140;
// Visual: cap how far the indicator slides from the gesture's edge.
// Keeps it visually close to where the user's finger is, not hovering
// in the middle of the screen.
const INDICATOR_MAX_TRAVEL = 24;

export function WfBody({
  children,
  style,
  scrollKey,
  onBack,
  onRefresh,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();

  // Visual state only — gesture truth lives in closure variables inside
  // the effect so touchend can read the final committed value without
  // racing React state batching.
  const [gesture, setGesture] = useState<null | 'back' | 'refresh'>(null);
  const [progress, setProgress] = useState(0);
  const [committedView, setCommittedView] = useState(false);
  const [busy, setBusy] = useState(false);
  // For the back gesture we anchor the indicator to the finger's Y
  // position (so it appears next to the thumb, not stuck in viewport
  // center). For refresh the indicator stays at the top — that's where
  // the user is dragging from.
  const [anchorY, setAnchorY] = useState(0);

  // ── Scroll restoration ───────────────────────────────────────────────
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

  // ── Edge-swipe-back + pull-to-refresh ────────────────────────────────
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Gesture truth — closure-local so we can read the last value inside
    // touchend without waiting on React state to flush.
    let active: null | 'back' | 'refresh' = null;
    let committed = false;
    let startX = 0;
    let startY = 0;
    let startScroll = 0;
    let lastDx = 0;
    let lastDy = 0;

    const resetVisuals = () => {
      setGesture(null);
      setProgress(0);
      setCommittedView(false);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        active = null;
        committed = false;
        return;
      }
      const t = e.touches[0]!;
      startX = t.clientX;
      startY = t.clientY;
      startScroll = el.scrollTop;
      active = null;
      committed = false;
      lastDx = 0;
      lastDy = 0;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0]!;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      lastDx = dx;
      lastDy = dy;

      if (!active) {
        if (onBack && startX < EDGE_ZONE_PX && dx > ACTIVATE_PX && adx > ady) {
          active = 'back';
        } else if (startScroll <= 0 && dy > ACTIVATE_PX && ady > adx) {
          active = 'refresh';
        } else {
          return;
        }
      }

      if (active === 'back') {
        committed = dx >= COMMIT_PX_BACK;
        const p = Math.min(Math.max(dx, 0) / COMMIT_PX_BACK, 1);
        setGesture('back');
        setProgress(p);
        setCommittedView(committed);
        // Anchor indicator to current finger Y so it stays next to the
        // thumb regardless of where the gesture started.
        setAnchorY(t.clientY);
        e.preventDefault();
      } else if (active === 'refresh') {
        const dyClamped = Math.min(Math.max(dy, 0), MAX_PULL_PX);
        committed = dy >= COMMIT_PX_REFRESH;
        const p = Math.min(dyClamped / COMMIT_PX_REFRESH, 1);
        setGesture('refresh');
        setProgress(p);
        setCommittedView(committed);
        e.preventDefault();
      }
    };

    const onTouchEnd = async () => {
      const wasActive = active;
      const wasCommitted = committed;
      active = null;
      committed = false;

      if (wasActive === 'back' && wasCommitted && onBack) {
        resetVisuals();
        onBack();
        return;
      }
      if (wasActive === 'refresh' && wasCommitted) {
        // Keep the indicator visible while refreshing so the user gets
        // feedback that something is happening.
        setBusy(true);
        try {
          if (onRefresh) {
            await onRefresh();
          } else {
            await queryClient.invalidateQueries();
            await queryClient.refetchQueries({ type: 'active' });
          }
        } catch {
          /* swallow */
        }
        setBusy(false);
        resetVisuals();
        return;
      }
      resetVisuals();
      void lastDx;
      void lastDy;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', () => {
      active = null;
      committed = false;
      resetVisuals();
    });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [onBack, onRefresh, queryClient]);

  // Choose icon: chevron for back, circular-refresh glyph for refresh.
  // Using two glyphs (not one rotating chevron) reads more clearly —
  // a chevron pointing left never quite means "refresh" to anyone.
  const isRefresh = gesture === 'refresh';

  return (
    <div ref={ref} className="wf-body" style={style}>
      {gesture && (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            zIndex: 50,
            width: 40,
            height: 40,
            borderRadius: 999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--paper)',
            // The border thickens + colors-in as the user approaches the
            // commit threshold — gives the same "fills up" feel as iOS
            // without the harsh paper→ink swap that read as "wrong" before.
            border: `1.5px solid ${committedView ? 'var(--ink)' : 'var(--line)'}`,
            color: committedView ? 'var(--ink)' : 'var(--hint)',
            boxShadow: '0 2px 12px rgba(0,0,0,.08)',
            opacity: Math.max(progress, 0.35),
            transition: 'border-color .12s ease, color .12s ease',
            pointerEvents: 'none',
            ...(isRefresh
              ? {
                  top: 0,
                  left: '50%',
                  transform: `translate(-50%, ${4 + progress * INDICATOR_MAX_TRAVEL}px)`,
                }
              : {
                  // Anchor to finger Y so the indicator sits next to the
                  // thumb. Clamp into the viewport with a 24px safe margin
                  // top/bottom so it doesn't get clipped near the chrome.
                  top: `${Math.max(24, Math.min(anchorY, (typeof window !== 'undefined' ? window.innerHeight : 800) - 24))}px`,
                  left: 0,
                  transform: `translate(${4 + progress * INDICATOR_MAX_TRAVEL}px, -50%)`,
                }),
          }}
        >
          {isRefresh ? (
            // Circular refresh arrow. When busy (post-release, awaiting
            // the refresh promise) we spin it. Otherwise the arc grows
            // with the pull progress.
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                animation: busy ? 'wf-spin 0.8s linear infinite' : 'none',
                transform: busy ? 'none' : `rotate(${progress * 270}deg)`,
              }}
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          ) : (
            // Left chevron for back — unambiguous "go back".
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 6 9 12 15 18" />
            </svg>
          )}
        </div>
      )}
      {children}
      {/* Inline keyframe for the spinner so we don't need to touch the
          shared CSS file. */}
      <style>{`@keyframes wf-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
