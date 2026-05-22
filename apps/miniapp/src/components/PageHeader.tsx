import type { ReactNode } from 'react';
import { Icon } from '../design';
import { useT } from '../i18n';

type Props = {
  /** Main heading text (h1-sized). */
  title: string;
  /** Subtitle shown to the right of (or under) the title. Optional. */
  subtitle?: string;
  /** If set, render a round "back" pill in the leading slot. Mutually
   *  exclusive with `onOpenDrawer` — the caller picks one based on
   *  whether the page was reached via in-app navigation (back) or via
   *  the burger drawer (no back). */
  onBack?: () => void;
  /** If set (and `onBack` isn't), render the hamburger icon in the
   *  leading slot. The button looks the same as `onBack` for visual
   *  consistency, just with a different glyph. */
  onOpenDrawer?: () => void;
  /** Trailing slot — e.g. balance pill, avatar stack, action menu. */
  right?: ReactNode;
};

/**
 * Unified header used on top of every page. Replaces the ad-hoc rows
 * each page used to assemble itself ([chevL][title] or [burger][title]…).
 *
 * Layout: leading button (back OR burger OR nothing) | title (+ optional
 * subtitle) | trailing slot. The leading button is a 36×36 black circle
 * with a white glyph — same visual weight as a `.wf-btn.primary` so it
 * reads as a real, tappable affordance instead of a hairline icon.
 *
 * Pages that need a more complex header (e.g. Calendar's month nav with
 * chevL/chevR around the month name) compose this with their extras
 * rather than re-rolling the whole row.
 */
export function PageHeader({
  title,
  subtitle,
  onBack,
  onOpenDrawer,
  right,
}: Props) {
  const t = useT();
  const leading =
    onBack != null
      ? { glyph: 'chevL' as const, onClick: onBack, label: t('common.back') }
      : onOpenDrawer != null
        ? { glyph: 'menu' as const, onClick: onOpenDrawer, label: t('nav.menu') }
        : null;

  return (
    <div className="wf-row wf-gap-8" style={{ alignItems: 'center' }}>
      {leading && (
        <button
          type="button"
          onClick={leading.onClick}
          aria-label={leading.label}
          style={{
            width: 36,
            height: 36,
            borderRadius: 999,
            background: 'var(--ink)',
            color: 'var(--paper)',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
          }}
        >
          <Icon name={leading.glyph} />
        </button>
      )}
      <div className="wf-col" style={{ flex: 1, minWidth: 0 }}>
        <span
          className="wf-h1"
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={title}
        >
          {title}
        </span>
        {subtitle && (
          <span
            className="wf-tiny"
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {subtitle}
          </span>
        )}
      </div>
      {right}
    </div>
  );
}
