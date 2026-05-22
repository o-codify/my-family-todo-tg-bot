import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export type ToastVariant = 'success' | 'error' | 'info';

export type ToastAction = {
  /** Visible label, e.g. "Отменить". */
  label: string;
  /** Fired on tap. The toast dismisses immediately after. */
  onClick: () => void;
};

export type ToastInput = {
  message: string;
  variant?: ToastVariant;
  /** Auto-dismiss after N ms. Defaults to 3000; pass 0 for sticky. */
  durationMs?: number;
  /** Optional inline action (typically "Отменить" for undo flows). */
  action?: ToastAction;
};

type Toast = ToastInput & {
  id: number;
  durationMs: number;
};

type ToastApi = {
  show: (input: ToastInput) => number;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION_MS = 3000;
const MAX_VISIBLE = 3;

/**
 * Wraps the app and exposes `useToast()`. Toasts render into a portal anchored
 * to `<body>` so they sit above sheets/drawers and aren't clipped by `.wf-body`
 * scroll containers. Keep the count low — we cap visible toasts at MAX_VISIBLE,
 * older ones fall off; if a flow needs persistent communication it should
 * own a banner, not stack toasts.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  // Track active timers so we can clear them on programmatic dismiss/unmount.
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle != null) {
      window.clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (input: ToastInput): number => {
      const id = nextId.current++;
      const durationMs = input.durationMs ?? DEFAULT_DURATION_MS;
      const toast: Toast = { ...input, id, durationMs };
      setToasts((prev) => {
        const next = [...prev, toast];
        // Drop the oldest if we'd exceed the cap. Their timers stay around;
        // dismiss() can no-op them but they'll auto-expire shortly anyway.
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
      });
      if (durationMs > 0) {
        const handle = window.setTimeout(() => dismiss(id), durationMs);
        timers.current.set(id, handle);
      }
      return id;
    },
    [dismiss],
  );

  // On unmount, clear any outstanding timers so we don't poke unmounted state.
  useEffect(() => {
    const handles = timers.current;
    return () => {
      for (const h of handles.values()) window.clearTimeout(h);
      handles.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ show, dismiss }}>
      {children}
      {typeof document !== 'undefined' &&
        createPortal(<ToastStack toasts={toasts} onDismiss={dismiss} />, document.body)}
    </ToastContext.Provider>
  );
}

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        pointerEvents: 'none',
        zIndex: 60,
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const isErr = toast.variant === 'error';
  const isInfo = toast.variant === 'info';
  return (
    <div
      role="status"
      style={{
        pointerEvents: 'auto',
        background: isErr ? 'var(--danger)' : isInfo ? 'var(--ink)' : 'var(--success)',
        color: '#fff',
        padding: '10px 14px',
        borderRadius: 12,
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        fontSize: 13,
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 12,
        maxWidth: 'calc(100vw - 32px)',
        animation: 'wf-toast-in 0.18s ease',
      }}
    >
      <span style={{ flex: 1 }}>{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action!.onClick();
            onDismiss();
          }}
          style={{
            background: 'rgba(255,255,255,0.18)',
            color: '#fff',
            border: 'none',
            borderRadius: 999,
            padding: '4px 10px',
            font: 'inherit',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

/**
 * Hook for any component to trigger a toast. Throws if used outside the
 * provider — surfacing the mis-config eagerly rather than silently no-op'ing.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
