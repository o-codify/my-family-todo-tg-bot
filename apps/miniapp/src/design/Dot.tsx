import type { Member } from './types';

type Props = { m?: Member | null; lg?: boolean };

/** Verbatim port of Dot (wireframe-kit.jsx lines 23-26). */
export function Dot({ m, lg = false }: Props) {
  const cls = `wf-dot wf-mc ${lg ? 'lg' : ''}`;
  return <span className={cls} style={{ background: m ? m.color : 'var(--softline)' }} />;
}
