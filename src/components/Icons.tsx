import type { CSSProperties } from 'react';

/* 图标全部转写自设计源 shared/app.js 与各屏内联 SVG，路径逐条对应 */

const PATHS = {
  /* 状态 */
  check: <path d="m5 13 4 4L19 7" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5m0 3h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  pot: (
    <>
      <path d="M5 11h14l-1.5 6.5a4 4 0 0 1-4 3h-3a4 4 0 0 1-4-3Z" />
      <path d="M8 11V8h8v3M9 8V5m6 3V5" />
    </>
  ),
  potEmpty: (
    <>
      <path d="M4 9h16v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3Z" />
      <path d="M4 9h16V7H4Z" />
    </>
  ),
  sync: (
    <>
      <path d="M20 11a8 8 0 0 0-14.8-3.5M4 13a8 8 0 0 0 14.8 3.5" />
      <path d="M20 3v5h-5M4 21v-5h5" />
    </>
  ),
  repo: (
    <>
      <rect x="4" y="4" width="16" height="13" rx="2" />
      <path d="M12 4v9" />
      <path d="m8 10 4 4 4-4" />
    </>
  ),

  /* 底部导航 */
  book: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
    </>
  ),
  order: (
    <>
      <rect x="6" y="3" width="12" height="18" rx="2" />
      <path d="M9 8h6M9 12h4" />
      <path d="M9 16l1.5 1.5L13 15" />
    </>
  ),
  menu: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="m9 12 2 2 4-4" />
      <path d="M9 8h6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,

  /* 操作 */
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  searchOff: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
      <path d="M8.5 11h5" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6 6 18" />,
  back: <path d="M15 6l-6 6 6 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  pencil: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9.5 7V4.5h5V7" />
      <path d="M6.5 7 7.5 20h9L17.5 7" />
      <path d="M10.5 11v5.5M13.5 11v5.5" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
      <path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
    </>
  ),
  save: (
    <>
      <path d="M5 4h11l4 4v12H5Z" />
      <path d="M9 4v6h6V4M8 20v-6h8v6" />
    </>
  ),
  shuffle: (
    <>
      <path d="M4 7h3l10 10h3" />
      <path d="M4 17h3l1.2-1.4" />
      <path d="M16.8 8.4 20 7l-2 3.2" />
      <circle cx="7" cy="7" r=".6" fill="currentColor" />
      <path d="m16 15 1 2h3" />
    </>
  ),
  send: (
    <>
      <path d="m4 12 16-7-6 15-3-6Z" />
      <path d="M11 14 20 5" />
    </>
  ),
  cart: (
    <>
      <path d="M6 2h12l-1 8H7Z" />
      <path d="M8 6h8" />
      <path d="M6 10 4 22h16l-2-12" />
      <path d="M9 15h6" />
    </>
  ),
  note: (
    <>
      <path d="M9 12h6M9 16h4" />
      <path d="M5 4h14v14l-3 3H5Z" />
    </>
  ),
  image: (
    <>
      <rect x="4" y="6" width="16" height="13" rx="2" />
      <path d="M4 15l4-3 3 2 4-4 5 4" />
      <circle cx="16" cy="9" r="1.4" />
    </>
  ),
  bag: (
    <>
      <path d="M4 8h16l-1.5 9a3 3 0 0 1-3 2.5h-7a3 3 0 0 1-3-2.5Z" />
      <path d="M8 8V6a4 4 0 0 1 8 0v2" />
    </>
  ),

  /* 身份 */
  roleOrderer: <path d="M8 4v4M8 8H4v4h4v4h4v-4h4V8h-4V4Z" fill="none" />,
  roleCook: (
    <>
      <path d="M5 11h14l-1.5 6.5a4 4 0 0 1-4 3h-3a4 4 0 0 1-4-3Z" />
      <path d="M8 11V8h8v3M9 8V5m6 3V5" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps {
  name: IconName;
  className?: string;
  style?: CSSProperties;
}

export function Icon({ name, className, style }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
