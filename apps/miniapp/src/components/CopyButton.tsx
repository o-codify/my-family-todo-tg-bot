import { useState, type CSSProperties } from 'react';
import { useT } from '../i18n';

/**
 * Shared copy-to-clipboard button. One look across the whole app —
 * idle ("Скопировать"), ok ("✓ Скопировано", green border + tint),
 * err ("Не получилось", red border). Auto-resets to idle after
 * `resetMs` (2.5 s default).
 *
 * The Profile invite-link button was the visual source of truth;
 * other places (ICS panel, etc.) used ad-hoc toasts that looked
 * different. Use this component instead of rolling another one.
 */

type Variant = 'default' | 'primary' | 'block';

type Props = {
  /** Text to copy when tapped. */
  value: string;
  /** Optional label override; defaults to t('common.copy') / "Скопировать". */
  label?: string;
  /** Pass through if the consumer wants the same row treatment. */
  variant?: Variant;
  /** Extra style overrides (flex layout etc.). */
  style?: CSSProperties;
  /** Auto-reset delay in ms. Default 2500. */
  resetMs?: number;
  /** Optional click hook (e.g. analytics). Runs before the copy. */
  onClick?: () => void;
};

export function CopyButton({
  value,
  label,
  variant = 'default',
  style,
  resetMs = 2500,
  onClick,
}: Props) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'ok' | 'err'>('idle');

  const klass =
    'wf-btn' + (variant === 'primary' ? ' primary' : '') + (variant === 'block' ? ' block' : '');

  const stateTint =
    state === 'ok'
      ? {
          borderColor: 'var(--success)',
          color: 'var(--success)',
          background: 'rgba(74, 154, 90, 0.08)',
        }
      : state === 'err'
        ? { borderColor: 'var(--danger)', color: 'var(--danger)' }
        : null;

  const handle = async () => {
    onClick?.();
    const ok = await writeClipboard(value);
    setState(ok ? 'ok' : 'err');
    window.setTimeout(() => setState('idle'), resetMs);
  };

  return (
    <button
      type="button"
      className={klass}
      onClick={handle}
      style={{
        cursor: 'pointer',
        ...stateTint,
        ...style,
      }}
    >
      {state === 'ok'
        ? `✓ ${t('common.copied')}`
        : state === 'err'
          ? t('common.copyFailed.short')
          : (label ?? t('common.copy'))}
    </button>
  );
}

/**
 * Robust clipboard write — async Clipboard API first, falls back to a
 * hidden-textarea + execCommand path that still works inside older
 * Telegram WebView versions where navigator.clipboard is blocked.
 *
 * Exported so callers that need just the copy mechanics (e.g. inside a
 * dropdown or non-button context) can reuse the same fallback chain.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy path — some WebView versions raise
      // "NotAllowedError" outside a transient user-gesture window.
    }
  }
  if (typeof document === 'undefined') return false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
