type Props = { pct?: number; color?: string };

/** Verbatim port of Bar (wireframe-kit.jsx lines 139-143). */
export function Bar({ pct = 50, color }: Props) {
  return (
    <span className="wf-bar" style={{ display: 'block', flex: 1 }}>
      <i style={{ width: pct + '%', background: color || 'var(--ink)' }} />
    </span>
  );
}
