import type { CSSProperties, ReactNode } from 'react';

type Props = { children: ReactNode; style?: CSSProperties };

/**
 * Live equivalent of the prototype's Phone shell — the chrome (notch, status
 * bar, home indicator) comes from Telegram in production, so we just expose the
 * scrollable `.wf-body` content area used by every wireframe screen.
 */
export function WfBody({ children, style }: Props) {
  return (
    <div className="wf-body" style={style}>
      {children}
    </div>
  );
}
