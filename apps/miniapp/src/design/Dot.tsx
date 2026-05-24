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
 *  opt-in `done` modifier for the month-grid dimming. */
export function Dot({ m, lg = false, done = false }: Props) {
  const cls = `wf-dot wf-mc ${lg ? 'lg' : ''}${done ? ' done' : ''}`;
  return (
    <span
      className={cls}
      style={{
        // Done dots use the design's softline token so they read as
        // "subordinate to the day's pending work". The member colour
        // is irrelevant once a task is closed.
        background: done ? 'var(--softline)' : m ? m.color : 'var(--softline)',
        opacity: done ? 0.55 : 1,
      }}
    />
  );
}
