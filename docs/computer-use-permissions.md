# Computer Use permissions

## Permission levels

| Level | Allowed intent | Examples |
| --- | --- | --- |
| `OBSERVE` | Read-only inspection | screenshots, reading a table, declaring done/fail |
| `INTERACT` | Reversible navigation | opening menus, changing date filters, scrolling |
| `MUTATE` | Persistent account changes | budget, bid or status changes after approval |
| `DESTRUCTIVE` | High-impact or difficult-to-recover changes | deletion or irreversible removal when explicitly enabled |

The declared task risk, grounded action risk and caller permission must agree. Utility actions such as `done`, `fail`, `wait` and `screenshot` are always observe-risk.

## macOS setup

1. Open System Settings → Privacy & Security.
2. Grant Screen Recording to the Terminal or app process that launches `adpilot`.
3. Grant Accessibility to the same process so NutJS can move the pointer and type.
4. Restart that process after changing permissions.
5. Start the client browser from AdPilot Settings or `adpilot browser start --client <id>` and log in manually. CAPTCHA, OTP and password prompts require user takeover.

## Surface allowlists

Each account entry in `accounts.yaml` names its browser Profile and allowed domains. AdPilot launches that Profile in a dedicated directory and binds it to the client, PID, application, window id/bounds and platform. Every visual microtask must name that exact session and may only narrow the stored domain allowlist. A subdomain is allowed only when its parent is explicitly listed; an unbound Profile, broader domain list, unrelated domain or application fails before execution.

On macOS, AppKit/CoreGraphics identify the foreground application, bundle id, PID, window id/title/bounds, screen and scale factor. AppleScript is fallback-only. Screenshots are bound-window captures, and model coordinates are validated in screenshot pixels before being translated to global logical coordinates for native execution. A different foreground window, replacement process, closed window or changed Profile produces `BROWSER_SESSION_LOST` and requires explicit user recovery.

## Failure behavior

AdPilot captures again and re-grounds only for non-mutating actions after failed verification. Attempts one and two use the current visual route; attempt three escalates to Deep and then returns a typed blocker. Mutations are never retried. A timeout stops immediately to avoid duplicating a native action that may finish late. Repeating coordinates is forbidden. Pause and takeover stop before the next screenshot; cancel is terminal for that runtime instance.

The logged-in-browser Prepare harness is even narrower: the user opens and focuses the draft field, then the harness permits one `type` action without Enter and one read-only confirmation. Clicks, hotkeys and retries are rejected before native input.
