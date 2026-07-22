/** Returns true only for URLs served by this desktop instance. */
export function isTrustedDesktopUrl(url: string, trustedOrigin: string): boolean {
  try {
    return new URL(url).origin === trustedOrigin;
  } catch {
    return false;
  }
}

/** Limits hand-offs to the operating system to ordinary web URLs. */
export function isExternalWebUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
