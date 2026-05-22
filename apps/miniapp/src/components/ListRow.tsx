import { Icon, type IconName } from '../design';

type Props = {
  /** Leading glyph slot. Limited to icons the design system actually
   *  ships — passing anything else is a typecheck error, which is the
   *  point. */
  icon?: IconName;
  /** Main label (`wf-label` size). */
  label: string;
  /** Optional muted value on the right (e.g. "08:00", current selection). */
  value?: string;
  /** Tap target. When omitted the row reads as static. */
  onClick?: () => void;
};

/**
 * Standardised "settings row" — icon · label · value · chevron-right.
 *
 * Extracted from Profile.tsx so both Settings (family-wide rows) and
 * MyProfile (personal rows) render identical lines. Same element, same
 * behaviour — no per-page redrawing.
 */
export function ListRow({ icon, label, value, onClick }: Props) {
  return (
    <div
      className="wf-card compact"
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      <div className="wf-spread">
        <div className="wf-row wf-gap-8">
          {icon && <Icon name={icon} />}
          <span className="wf-label">{label}</span>
        </div>
        <div className="wf-row wf-gap-6">
          {value && <span className="wf-hint">{value}</span>}
          <Icon name="chevR" />
        </div>
      </div>
    </div>
  );
}
