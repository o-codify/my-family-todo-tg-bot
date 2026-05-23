import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Drag-to-reschedule wiring. The Calendar page picks up a pending
 * occurrence (the user holds + drags a row from the day list) and
 * drops it on a different calendar cell to move it to that date.
 *
 * Why Pointer Events and not HTML5 drag-and-drop? Drag-and-drop on
 * iOS Safari (and inside Telegram WebView) is unreliable — events
 * don't fire on touch reliably. Pointer Events give us one model
 * that works for both mouse and touch.
 *
 * Activation gate: a tiny 8 px movement threshold separates a tap
 * (open the task) from a drag (reschedule). Without it every tap on
 * a card would steal focus from `onClick`.
 */

export type DragRescheduleState = {
  /** Occurrence id currently being dragged, or null. */
  draggingId: string | null;
  /** Calendar cell ISO under the pointer (set by `onCellEnter`). */
  hoverIso: string | null;
};

export type UseDragReschedule = {
  state: DragRescheduleState;
  /** Bind to a DayTaskCard root — starts the drag after 8 px of
   *  movement; `onTap` runs only when the pointer is released without
   *  crossing the threshold. */
  bindCard: (
    occurrenceId: string,
    occCurrentIso: string | null,
    onTap: () => void,
  ) => {
    onPointerDown: (e: React.PointerEvent) => void;
    style: React.CSSProperties;
  };
  /** Bind to each grid cell — flags hover, fires drop. */
  bindCell: (iso: string) => {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
  };
};

const THRESHOLD_PX = 8;

export function useDragReschedule(input: {
  /** Called with (occurrenceId, targetIso) on a successful drop on
   *  a cell that's different from the current scheduled date. */
  onDrop: (occurrenceId: string, targetIso: string) => void;
}): UseDragReschedule {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverIso, setHoverIso] = useState<string | null>(null);

  // Refs survive re-renders without re-binding window listeners.
  const startRef = useRef<{
    x: number;
    y: number;
    occurrenceId: string;
    currentIso: string | null;
    onTap: () => void;
    crossed: boolean;
  } | null>(null);
  const hoverIsoRef = useRef<string | null>(null);

  const reset = useCallback(() => {
    startRef.current = null;
    hoverIsoRef.current = null;
    setDraggingId(null);
    setHoverIso(null);
  }, []);

  useEffect(() => {
    if (!draggingId) return;
    // Block iOS overscroll while a drag is in flight — pull-to-refresh
    // would intercept the gesture mid-drop.
    const prev = document.body.style.overscrollBehavior;
    document.body.style.overscrollBehavior = 'none';
    return () => {
      document.body.style.overscrollBehavior = prev;
    };
  }, [draggingId]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const s = startRef.current;
      if (!s) return;
      if (!s.crossed) {
        const dx = e.clientX - s.x;
        const dy = e.clientY - s.y;
        if (dx * dx + dy * dy >= THRESHOLD_PX * THRESHOLD_PX) {
          s.crossed = true;
          setDraggingId(s.occurrenceId);
        }
      }
    };
    const onUp = () => {
      const s = startRef.current;
      if (!s) return;
      if (s.crossed) {
        // Drop — fire onDrop only when we hovered a different cell.
        const target = hoverIsoRef.current;
        if (target && target !== s.currentIso) {
          input.onDrop(s.occurrenceId, target);
        }
      } else {
        // No movement → treat as tap.
        s.onTap();
      }
      reset();
    };
    const onCancel = () => reset();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [input.onDrop, reset]);

  const bindCard: UseDragReschedule['bindCard'] = useCallback(
    (occurrenceId, occCurrentIso, onTap) => ({
      onPointerDown: (e) => {
        // Ignore non-primary buttons + nested interactive elements (the
        // checkbox / 3-dot menu have their own click handlers).
        if (e.button !== 0 && e.pointerType !== 'touch') return;
        startRef.current = {
          x: e.clientX,
          y: e.clientY,
          occurrenceId,
          currentIso: occCurrentIso,
          onTap,
          crossed: false,
        };
      },
      style: {
        // Without `touch-action: none`, mobile browsers swallow our
        // pointermove events to scroll the page instead.
        touchAction: 'pan-y',
        opacity: draggingId === occurrenceId ? 0.5 : 1,
        transition: 'opacity 0.15s ease',
      },
    }),
    [draggingId],
  );

  const bindCell: UseDragReschedule['bindCell'] = useCallback(
    (iso) => ({
      onPointerEnter: () => {
        if (!startRef.current?.crossed) return;
        hoverIsoRef.current = iso;
        setHoverIso(iso);
      },
      onPointerLeave: () => {
        if (hoverIsoRef.current === iso) {
          hoverIsoRef.current = null;
          setHoverIso(null);
        }
      },
    }),
    [],
  );

  return { state: { draggingId, hoverIso }, bindCard, bindCell };
}
