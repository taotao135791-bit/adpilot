import type { ReactNode } from "react";

/**
 * Hand-drawn inline icon set. One stroke width (1.5) and one 24×24 grid
 * across every icon so the interface reads as a single family. All icons
 * inherit `currentColor` and scale with the `size` prop.
 */

type IconProps = { size?: number; className?: string };

function createIcon(children: ReactNode) {
  function Icon({ size = 16, className }: IconProps) {
    return (
      <svg
        className={className}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {children}
      </svg>
    );
  }
  return Icon;
}

export const IconChat = createIcon(
  <>
    <path d="M6.5 4.5h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9.2l-3.9 3.1a.5.5 0 0 1-.8-.4V6.5a2 2 0 0 1 2-2z" />
  </>
);

export const IconTarget = createIcon(
  <>
    <circle cx="12" cy="12" r="7.5" />
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 12h.01" strokeWidth={2.5} />
  </>
);

export const IconShieldCheck = createIcon(
  <>
    <path d="M12 3.5 5 6v5.5c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6l-7-2.5z" />
    <path d="m9.2 11.8 2 2 3.6-4" />
  </>
);

export const IconLedger = createIcon(
  <>
    <path d="M4.5 19.5v-9" />
    <path d="M9.7 19.5v-15" />
    <path d="M14.8 19.5v-7" />
    <path d="M20 19.5V8" />
  </>
);

export const IconSettings = createIcon(
  <>
    <path d="M3.5 8h8.2" />
    <circle cx="14.5" cy="8" r="2.3" />
    <path d="M16.8 8h3.7" />
    <path d="M3.5 16h3.2" />
    <circle cx="9.5" cy="16" r="2.3" />
    <path d="M11.8 16h8.7" />
  </>
);

export const IconSend = createIcon(
  <>
    <path d="M19.8 4.2 4.1 10.5c-.4.16-.4.7.03.85l5.3 1.9 2 5.3c.16.4.7.43.86.03l7.5-14.4z" />
    <path d="M19.8 4.2l-10.4 9" />
  </>
);

export const IconPause = createIcon(
  <>
    <path d="M9.2 5.5v13" />
    <path d="M14.8 5.5v13" />
  </>
);

export const IconPlay = createIcon(
  <>
    <path d="M8.2 5.3v13.4c0 .6.66.94 1.16.6l10.1-6.7a.72.72 0 0 0 0-1.2L9.36 4.7c-.5-.34-1.16 0-1.16.6z" />
  </>
);

export const IconTakeover = createIcon(
  <>
    <circle cx="9.5" cy="7.5" r="3" />
    <path d="M4 19.5c.6-3.2 2.8-5 5.5-5 1.5 0 2.9.6 3.9 1.7" />
    <path d="M20.5 9.5h-5" />
    <path d="m18 7-2.5 2.5L18 12" />
  </>
);

export const IconError = createIcon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V13" />
    <path d="M12 16.2v.3" />
  </>
);

export const IconInfo = createIcon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5" />
    <path d="M12 7.7v.3" />
  </>
);

export const IconBot = createIcon(
  <>
    <rect x="5" y="8.5" width="14" height="10" rx="2.5" />
    <path d="M12 8.5V5.8" />
    <circle cx="12" cy="4.6" r="1.1" />
    <path d="M9.6 13h.01M14.4 13h.01" strokeWidth={2.2} />
    <path d="M9.6 16h4.8" />
  </>
);

export const IconFork = createIcon(
  <>
    <circle cx="6.5" cy="5.5" r="2" />
    <circle cx="6.5" cy="18.5" r="2" />
    <circle cx="17.5" cy="8.5" r="2" />
    <path d="M6.5 7.5v9" />
    <path d="M17.5 10.5c0 4.4-4.4 4.7-8.2 5.3" />
  </>
);

export const IconHistory = createIcon(
  <>
    <path d="M5.4 5.6A8 8 0 1 1 4 12" />
    <path d="M4 4.2v4h4" />
    <path d="M12 8v4.4l3 1.8" />
  </>
);

export const IconAlert = createIcon(
  <>
    <path d="M12 4.2 3 19.3h18L12 4.2z" />
    <path d="M12 9.5v4.4" />
    <path d="M12 16.7v.3" />
  </>
);

export const IconDesktop = createIcon(
  <>
    <rect x="3" y="4.5" width="18" height="12.5" rx="2" />
    <path d="M9 20.5h6" />
    <path d="M12 17v3.5" />
  </>
);

export const IconDismiss = createIcon(
  <>
    <path d="m6 6 12 12" />
    <path d="m18 6-12 12" />
  </>
);

export const IconRefresh = createIcon(
  <>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 3.6v4h-4" />
  </>
);

export const IconOpen = createIcon(
  <>
    <path d="M14 4h6v6" />
    <path d="M20 4l-9.5 9.5" />
    <path d="M19 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4.5" />
  </>
);

export const IconStop = createIcon(
  <>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </>
);

export const IconShieldLock = createIcon(
  <>
    <path d="M12 3.5 5 6v5.5c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6l-7-2.5z" />
    <rect x="9" y="10.6" width="6" height="4.9" rx="1.2" />
    <path d="M10.2 10.6V9.4a1.8 1.8 0 0 1 3.6 0v1.2" />
  </>
);

export const IconArrowUpRight = createIcon(
  <>
    <path d="M7 17 17 7" />
    <path d="M8.5 7H17v8.5" />
  </>
);

export const IconHelp = createIcon(
  <>
    <path d="M9.3 9a2.8 2.8 0 1 1 4 2.5c-.9.5-1.3 1-1.3 2" />
    <path d="M12 16.8v.3" />
  </>
);

export const IconChevronDown = createIcon(
  <>
    <path d="m6 9.5 6 6 6-6" />
  </>
);

export const IconPlan = createIcon(
  <>
    <path d="m4 6.2 1.3 1.3L7.6 5" />
    <path d="M10.8 6.2h8.7" />
    <path d="m4 12.2 1.3 1.3 2.3-2.5" />
    <path d="M10.8 12.2h8.7" />
    <path d="m4 18.2 1.3 1.3 2.3-2.5" />
    <path d="M10.8 18.2h8.7" />
  </>
);

export const IconPlus = createIcon(
  <>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </>
);

export const IconMenu = createIcon(
  <>
    <path d="M4 7h16" />
    <path d="M4 12h16" />
    <path d="M4 17h16" />
  </>
);

export const IconBolt = createIcon(
  <>
    <path d="M13 2.5 4.5 13.5H11l-1 8L18.5 10.5H12l1-8z" />
  </>
);

export const IconChip = createIcon(
  <>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5" />
  </>
);
