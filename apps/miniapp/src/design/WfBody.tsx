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

/** How long after mount we keep retrying the scroll restoration as
 *  content streams in via async queries. After this window we stop —
 *  the user is most likely already interacting. */
const RESTORE_WINDOW_MS = 1500;

/**
 * Live equivalent of the prototype's Phone shell — the chrome (notch, status
 * bar, home indicator) comes from Telegram in production, so we just expose the
 * scrollable `.wf-body` content area used by every wireframe screen.
 */
export function WfBody({ children, style, scrollKey }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!scrollKey) return;
    const el = ref.current;
    if (!el) return;
    const saved = scrollCache.get(scrollKey);
    if (saved == null || saved === 0) return;

    // First attempt — sync, before paint. Works when the content was already
    // laid out (cached queries, no async data).
    el.scrollTop = saved;

    // Async content keeps growing the page after mount (TanStack Query
    // hydrates a few hundred ms later). If `saved` exceeds current
    // maxScroll, the browser clamps to 0 and we lose the restoration.
    // ResizeObserver retries each time the scrollHeight grows, up to a
    // hard cap. Stop early if the user starts scrolling — we don't want
    // to override their input.
    let userInteracted = false;
    let timedOut = false;
    const startedAt = Date.now();

    const tryRestore = () => {
      if (userInteracted || timedOut) return;
      const max = el.scrollHeight - el.clientHeight;
      const target = Math.min(saved, max);
      if (Math.abs(el.scrollTop - target) > 1) {
        el.scrollTop = target;
      }
      // Once we hit the saved value exactly (content is tall enough), stop.
      if (max >= saved) {
        ro.disconnect();
      }
    };

    const onUserScroll = (e: Event) => {
      // Wheel / touchmove / keydown are real user input. Programmatic
      // `el.scrollTop = ...` fires `scroll` but not `wheel`/`touchmove`.
      void e;
      userInteracted = true;
      ro.disconnect();
    };

    const ro = new ResizeObserver(tryRestore);
    ro.observe(el);
    // Also observe the children container — `el` itself may not grow
    // (it has flex), but its first child (the content) does.
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
      // Final save on unmount: at this point the user's last scroll position
      // is the source of truth for next mount.
      void startedAt;
      scrollCache.set(scrollKey, el.scrollTop);
    };
  }, [scrollKey]);

  // Update the cache on every scroll while mounted (cheap — one number
  // per frame). Belt-and-braces alongside the unmount save.
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

  return (
    <div ref={ref} className="wf-body" style={style}>
      {children}
    </div>
  );
}
