import { Av } from './Av';
import type { Member } from './types';

type Props = {
  members: Member[];
  max?: number;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
};

/**
 * Port of AvStack (wireframe-kit.jsx lines 70-84). Original took `ids` + global
 * BY map; the live app passes resolved members directly.
 */
export function AvStack({ members, max = 4, size = 'sm' }: Props) {
  const show = members.slice(0, max);
  const extra = members.length - show.length;
  return (
    <span style={{ display: 'inline-flex' }}>
      {show.map((m, i) => (
        <span key={m.id} style={{ marginLeft: i ? -8 : 0 }}>
          <Av m={m} size={size} />
        </span>
      ))}
      {extra > 0 && (
        <span
          className="wf-av"
          style={{
            marginLeft: -8,
            background: 'var(--paper)',
            color: 'var(--ink)',
            fontSize: 10,
          }}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
