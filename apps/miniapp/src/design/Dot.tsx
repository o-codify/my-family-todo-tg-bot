import type { Member } from './types';

type Props = {
  m?: Member | null;
  lg?: boolean;
  /** When true, render the dot in a muted/dimmed state. Used on the
   *  calendar month grid so completed-task dots fade into the
   *  background and pending ones stand out. */
  done?: boolean;
};

/** Verbatim port of Dot (wireframe-kit.jsx lines 23-26), with an
 *  opt-in `done` modifier that only dims via opacity — the member
 *  colour stays so you can still tell whose dot it is at a glance.
 *  User said "тусклее точки, а не серым": keep colour, fade it. */
export function Dot({ m, lg = false, done = false }: Props) {
  const cls = `wf-dot wf-mc ${lg ? 'lg' : ''}${done ? ' done' : ''}`;
  return (
    <span
      className={cls}
      style={{
        background: m ? m.color : 'var(--softline)',
        opacity: done ? 0.35 : 1,
      }}
    />
  );
}
