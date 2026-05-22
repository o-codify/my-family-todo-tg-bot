import type { ReactNode } from 'react';

export type IconName =
  | 'plus'
  | 'check'
  | 'x'
  | 'chevR'
  | 'chevL'
  | 'chevD'
  | 'cal'
  | 'bell'
  | 'more'
  | 'edit'
  | 'trash'
  | 'repeat'
  | 'users'
  | 'user'
  | 'star'
  | 'trophy'
  | 'gift'
  | 'cam'
  | 'list'
  | 'zap'
  | 'chart'
  | 'sett'
  | 'search'
  | 'award'
  | 'plane'
  | 'invite'
  | 'pkg'
  | 'clock'
  | 'flag'
  | 'menu';

/** Verbatim port of I (wireframe-kit.jsx lines 34-67) — same SVG paths. */
export function Icon({ name }: { name: IconName }) {
  const path: ReactNode =
    PATHS[name] ?? <circle cx="12" cy="12" r="3" />;
  return (
    <span className="ic">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {path}
      </svg>
    </span>
  );
}

const PATHS: Record<IconName, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  check: <polyline points="3 12 9 18 21 5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  chevR: <polyline points="9 6 15 12 9 18" />,
  chevL: <polyline points="15 6 9 12 15 18" />,
  chevD: <polyline points="6 9 12 15 18 9" />,
  cal: (
    <g>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </g>
  ),
  bell: <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2H4.5L6 16zM10 21a2 2 0 0 0 4 0" />,
  more: (
    <g>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </g>
  ),
  edit: <path d="M4 20h4l10-10-4-4L4 16v4z" />,
  trash: (
    <g>
      <path d="M4 6h16M9 6V4h6v2M6 6l1 14h10l1-14" />
    </g>
  ),
  repeat: (
    <g>
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </g>
  ),
  users: (
    <g>
      <circle cx="9" cy="8" r="3" />
      <circle cx="17" cy="9" r="2" />
      <path d="M3 20c0-3 2-5 6-5s6 2 6 5M15 20c0-2 2-3 4-3s2 1 2 3" />
    </g>
  ),
  user: (
    <g>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </g>
  ),
  star: <polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9" />,
  trophy: (
    <g>
      <path d="M8 4h8v4a4 4 0 0 1-8 0V4z" />
      <path d="M16 5h3v2a3 3 0 0 1-3 3M8 5H5v2a3 3 0 0 0 3 3" />
      <path d="M9 13h6v2H9zM7 19h10v2H7zM11 15h2v4h-2z" />
    </g>
  ),
  gift: (
    <g>
      <rect x="3" y="8" width="18" height="4" />
      <rect x="5" y="12" width="14" height="9" />
      <path d="M12 8v13M12 8s-3-5-6-3 1 3 1 3M12 8s3-5 6-3-1 3-1 3" />
    </g>
  ),
  cam: (
    <g>
      <path d="M4 7h3l2-2h6l2 2h3v12H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </g>
  ),
  list: (
    <g>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </g>
  ),
  zap: <polygon points="13 2 4 14 11 14 9 22 20 10 13 10" />,
  chart: <g>
      <path d="M4 20V8M10 20V4M16 20v-8M22 20H2" />
    </g>,
  sett: (
    <g>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.2-1.6l2-1.5-2-3.4-2.4.8a7 7 0 0 0-2.7-1.6L13.2 2h-2.4l-.5 2.7a7 7 0 0 0-2.7 1.6L5.2 5.5l-2 3.4 2 1.5A7 7 0 0 0 5 12a7 7 0 0 0 .2 1.6l-2 1.5 2 3.4 2.4-.8a7 7 0 0 0 2.7 1.6l.5 2.7h2.4l.5-2.7a7 7 0 0 0 2.7-1.6l2.4.8 2-3.4-2-1.5A7 7 0 0 0 19 12z" />
    </g>
  ),
  search: (
    <g>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </g>
  ),
  award: (
    <g>
      <circle cx="12" cy="9" r="6" />
      <path d="M8.5 13.5 7 22l5-3 5 3-1.5-8.5" />
    </g>
  ),
  plane: <path d="M2 16l20-8-7 14-3-6-6-3z" />,
  invite: (
    <g>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 20c0-3 3-6 7-6s7 3 7 6" />
      <path d="M17 11v6M14 14h6" />
    </g>
  ),
  pkg: (
    <g>
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </g>
  ),
  clock: (
    <g>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </g>
  ),
  flag: (
    <g>
      <path d="M5 21V4h11l-2 4 2 4H5" />
    </g>
  ),
  menu: <path d="M3 6h18M3 12h18M3 18h18" />,
};
