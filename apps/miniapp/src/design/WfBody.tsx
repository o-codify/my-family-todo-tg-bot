import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  style?: CSSProperties;
  /**
   * Persist the scroll position of this body under a stable key across
   * mount/unmount cycles. When the user navigates away from a tab and
   * back, the scroller restores to wherever they were instead of jumping
   * to the top. Pass a key per logical screen (e.g. `'profile'`).
   * If omitted, no persistence — the scroller starts at 0 every mount.
   */
  scrollKey?: string;
};

/**
 * Module-level cache of last-known scroll positions, keyed by `scrollKey`.
 * Lives in memory only — refresh / reload resets to 0, which matches the
 * routing intent (cold start should not deep-link into mid-page).
 */
const scrollCache = new Map<string, number>();

/**
 * Live equivalent of the prototype's Phone shell — the chrome (notch, status
 * bar, home indicator) comes from Telegram in production, so we just expose the
 * scrollable `.wf-body` content area used by every wireframe screen.
 */
export function WfBody({ children, style, scrollKey }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Restore before paint so the user never sees the page flash at scroll 0.
  useLayoutEffect(() => {
    if (!scrollKey) return;
    const el = ref.current;
    const saved = scrollCache.get(scrollKey);
    if (el && saved != null) el.scrollTop = saved;
  }, [scrollKey]);

  // Live update on each scroll event (cheap — single number assignment per
  // frame) so navigating away after a fast tap captures the latest position.
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
      // Final write on unmount in case the user scrolled then immediately
      // hit a nav link before the next rAF tick fired.
      scrollCache.set(scrollKey, el.scrollTop);
    };
  }, [scrollKey]);

  return (
    <div ref={ref} className="wf-body" style={style}>
      {children}
    </div>
  );
}
