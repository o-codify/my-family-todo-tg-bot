type Props = {
  items: readonly string[];
  active: string;
  full?: boolean;
  onChange?: (value: string) => void;
};

/**
 * Port of Seg (wireframe-kit.jsx lines 146-150). Adds `onChange` so the control
 * is interactive in the live app — the prototype was static.
 */
export function Seg({ items, active, full = false, onChange }: Props) {
  return (
    <div className={`wf-seg${full ? ' full' : ''}`}>
      {items.map((it) => (
        <span
          key={it}
          className={it === active ? 'on' : ''}
          onClick={() => onChange?.(it)}
          style={{ cursor: onChange ? 'pointer' : undefined }}
        >
          {it}
        </span>
      ))}
    </div>
  );
}
