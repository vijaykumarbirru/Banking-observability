import { ReactNode } from 'react';

const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

const PATHS: Record<string, ReactNode> = {
  growth: <><path {...p} d="M3 17l6-6 4 4 8-8" /><path {...p} d="M15 7h6v6" /></>,
  card: <><rect {...p} x="2.5" y="5" width="19" height="14" rx="2.5" /><path {...p} d="M2.5 10h19M6.5 15h4" /></>,
  home: <><path {...p} d="M3 11l9-7 9 7" /><path {...p} d="M5 10v10h14V10M10 20v-6h4v6" /></>,
  send: <><path {...p} d="M21 3L10 14" /><path {...p} d="M21 3l-7 18-4-7-7-4 18-7z" /></>,
  wallet: <><path {...p} d="M3 7a2 2 0 012-2h13v4" /><rect {...p} x="3" y="7" width="18" height="13" rx="2" /><path {...p} d="M16 13.5h2" /></>,
  gift: <><rect {...p} x="3" y="8" width="18" height="4" rx="1" /><path {...p} d="M5 12v8h14v-8M12 8v12M12 8S10.5 4 8 4a2 2 0 000 4h4zM12 8s1.5-4 4-4a2 2 0 010 4h-4z" /></>,
  shield: <><path {...p} d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" /><path {...p} d="M9 12l2 2 4-4" /></>,
  plane: <path {...p} d="M10.5 13.5L3 11l1.5-1.5 7.5 1 4-4c1-1 3-1.5 3.5-1s0 2.5-1 3.5l-4 4 1 7.5L14 22l-2.5-7.5-3 3V20l-1.5 1-1-3-3-1 1-1.5h2.5l3-3z" />,
  lock: <><rect {...p} x="4" y="10" width="16" height="11" rx="2" /><path {...p} d="M8 10V7a4 4 0 018 0v3M12 14v3" /></>,
  eye: <><path {...p} d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle {...p} cx="12" cy="12" r="3" /></>,
  eyeOff: <><path {...p} d="M3 3l18 18M10.6 5.1A10 10 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4.1M6.6 6.6A17 17 0 002 12s3.5 7 10 7a9.7 9.7 0 005.4-1.6" /><path {...p} d="M9.9 9.9a3 3 0 004.2 4.2" /></>,
  alert: <><path {...p} d="M12 3l9.5 17h-19L12 3z" /><path {...p} d="M12 10v4M12 17.5v.01" /></>,
  phone: <path {...p} d="M5 3h4l2 5-2.5 1.5a11 11 0 006 6L16 13l5 2v4a2 2 0 01-2 2A17 17 0 013 5a2 2 0 012-2z" />,
  pin: <><path {...p} d="M12 21s7-6.2 7-12a7 7 0 00-14 0c0 5.8 7 12 7 12z" /><circle {...p} cx="12" cy="9" r="2.5" /></>,
  grid: <><rect {...p} x="3" y="3" width="7" height="7" rx="1.5" /><rect {...p} x="14" y="3" width="7" height="7" rx="1.5" /><rect {...p} x="3" y="14" width="7" height="7" rx="1.5" /><rect {...p} x="14" y="14" width="7" height="7" rx="1.5" /></>,
  transfer: <><path {...p} d="M4 8h14l-4-4M20 16H6l4 4" /></>,
  users: <><circle {...p} cx="9" cy="8" r="3.5" /><path {...p} d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.6a3.5 3.5 0 010 6.8M18 14.8c1.8.7 3 2.4 3.5 5.2" /></>,
  file: <><path {...p} d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" /><path {...p} d="M14 3v5h5M9 13h6M9 17h4" /></>,
  bell: <><path {...p} d="M6 9a6 6 0 0112 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z" /><path {...p} d="M10 20a2 2 0 004 0" /></>,
  chevron: <path {...p} d="M6 9l6 6 6-6" />,
  logout: <><path {...p} d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l-5-5 5-5M5 12h11" /></>,
  user: <><circle {...p} cx="12" cy="8" r="4" /><path {...p} d="M4 21c1-4 4-6 8-6s7 2 8 6" /></>,
  bill: <><path {...p} d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z" /><path {...p} d="M9 8h6M9 12h6" /></>,
  plus: <path {...p} d="M12 5v14M5 12h14" />,
  download: <><path {...p} d="M12 4v11M7 10l5 5 5-5" /><path {...p} d="M5 20h14" /></>,
  arrowUp: <path {...p} d="M7 17L17 7M9 7h8v8" />,
  arrowDown: <path {...p} d="M17 7L7 17M15 17H7V9" />,
  cash: <><rect {...p} x="2.5" y="6" width="19" height="12" rx="2" /><circle {...p} cx="12" cy="12" r="2.5" /><path {...p} d="M6 9.5v.01M18 14.5v.01" /></>,
  briefcase: <><rect {...p} x="3" y="7" width="18" height="13" rx="2" /><path {...p} d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2M3 13h18" /></>,
  bag: <><path {...p} d="M5 8h14l-1 12H6L5 8z" /><path {...p} d="M9 8V6a3 3 0 016 0v2" /></>,
  mobile: <><rect {...p} x="7" y="2.5" width="10" height="19" rx="2" /><path {...p} d="M11 18h2" /></>,
  refresh: <><path {...p} d="M20 11a8 8 0 00-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0014.5 4.5L20 16M20 20v-4h-4" /></>,
  bank: <><path {...p} d="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" /></>,
  fd: <><circle {...p} cx="12" cy="12" r="8.5" /><path {...p} d="M12 7v5l3 2" /></>,
};

export default function Icon({ name, size = 24 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
