import type { Member } from './types';

type Props = {
  m?: Member | null;
  lg?: boolean;
  /** When true, render the dot in a muted/dimmed state. Used on the
   *  calendar month grid so completed-task dots fade into the
   *  background and pending ones stand out. */
  done?: boolean;
  /** When true, mark this as a shared task (has participants) with a
   *  contrasting ring so it doesn't read as one person's personal task. */
  shared?: boolean;
};

/** Verbatim port of Dot (wireframe-kit.jsx lines 23-26), with an
 *  opt-in `done` modifier that only dims via opacity — the member
 *  colour stays so you can still tell whose dot it is at a glance.
 *  User said "тусклее точки, а не серым": keep colour, fade it. */
export function Dot({ m, lg = false, done = false, shared = false }: Props) {
  const cls = `wf-dot wf-mc ${lg ? 'lg' : ''}${done ? ' done' : ''}`;
  return (
    <span
      className={cls}
      style={{
        background: m ? m.color : 'var(--softline)',
        opacity: done ? 0.35 : 1,
        // Shared tasks get a ring (paper gap + ink outline) so a group
        // chore stands out from a solo one on the dense month grid.
        ...(shared
          ? { boxShadow: '0 0 0 1.5px var(--paper), 0 0 0 3px var(--ink)' }
          : null),
      }}
    />
  );
}
