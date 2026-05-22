import type { ReactNode } from 'react';

type Props = { children: ReactNode; variant?: 'solid' | 'danger' | 'warn' | 'success' };

/** Verbatim port of Tag (wireframe-kit.jsx lines 29-31). */
export function Tag({ children, variant }: Props) {
  return <span className={`wf-tag${variant ? ' ' + variant : ''}`}>{children}</span>;
}
