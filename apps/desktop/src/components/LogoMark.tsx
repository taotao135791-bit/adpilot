/**
 * The AdPilot mark: a rounded-square tile with an "A" drawn as an ascending
 * trajectory (advertising + pilot). Fully monochrome — it inherits the ink
 * of whichever theme hosts it.
 */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="logo-mark">
      <rect x="2" y="2" width="20" height="20" rx="5.5" className="logo-mark-bg" />
      <path d="M7.5 16 12 6.8 16.5 16" className="logo-mark-cut" />
      <path d="M9.6 12.8h4.8" className="logo-mark-cut" />
    </svg>
  );
}
