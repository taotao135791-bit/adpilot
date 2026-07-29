import type { ReactNode } from "react";
import { IconDiamondFilled, IconSettings } from "../icons.js";

/**
 * View top bar: the breadcrumb trail on the left (brand diamond + path
 * segments separated by thin slashes) and a single settings affordance on
 * the right. Segment lists are intentionally short — one to three crumbs.
 */
export function TopBar({ crumbs, settingsLabel, onOpenSettings, trailing }: {
  crumbs: string[];
  settingsLabel: string;
  onOpenSettings: () => void;
  trailing?: ReactNode;
}) {
  return (
    <header className="topbar">
      <nav className="topbar-crumbs" aria-label="breadcrumb">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb}-${index}`} className="topbar-crumb" data-root={index === 0 || undefined}>
            {index === 0 && <IconDiamondFilled size={10} />}
            {index > 0 && <i aria-hidden="true">/</i>}
            <span>{crumb}</span>
          </span>
        ))}
      </nav>
      {trailing}
      <button type="button" className="topbar-settings" aria-label={settingsLabel} onClick={onOpenSettings}>
        <IconSettings size={15} />
      </button>
    </header>
  );
}
