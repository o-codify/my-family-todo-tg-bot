import type { Member } from './types';

type Props = {
  m?: Member | null;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  dim?: boolean;
};

/** Verbatim port of Av (wireframe-kit.jsx lines 12-20). */
export function Av({ m, size = 'md', dim = false }: Props) {
  if (!m) {
    return (
      <span
        className={`wf-av wf-mc ${size === 'md' ? '' : size}`}
        style={{ background: 'var(--softline)' }}
      >
        ?
      </span>
    );
  }
  const cls = ['wf-av', 'wf-mc'];
  if (size !== 'md') cls.push(size);
  return (
    <span
      className={cls.join(' ')}
      style={{ background: m.color, opacity: dim ? 0.45 : 1 }}
    >
      {m.letter}
    </span>
  );
}
