# Permission Center

Status: implementation contract

## Permission record

```ts
type PermissionStatus =
  | "granted"
  | "denied"
  | "not_determined"
  | "restricted"
  | "requires_restart"
  | "unavailable";

interface SystemPermission {
  id: string;
  status: PermissionStatus;
  required: boolean;
  reason: string;
  affectedFeatures: string[];
  canRequest: boolean;
  canOpenSettings: boolean;
  lastCheckedAt: string;
  source: "native_helper" | "electron" | "daemon";
}
```

## Managed capabilities

- Screen Recording
- Accessibility
- Automation
- Files and Folders
- Notifications
- Browser Control
- Clipboard
- Keychain
- Background Service
- Login Item
- optional Microphone and Camera

These are OS capabilities and are distinct from a Session permission profile such as read-only, workspace access, Computer Use, or advertising mutation.

## macOS flow

1. The native helper reports `CGPreflightScreenCaptureAccess` and `AXIsProcessTrusted`.
2. First-run onboarding explains the exact feature impact before any prompt.
3. Request invokes the corresponding native API when macOS permits it.
4. “Open System Settings” navigates to the correct Privacy & Security pane.
5. Recheck calls the helper again; the renderer never assumes the result.
6. A bounded test captures a harmless frame or performs a non-mutating accessibility probe.
7. Revocation is detected on app focus and before each Computer Use task.

Computer Use readiness requires helper health, Screen Recording, Accessibility for input tasks, a supported model, and an exact browser binding. Missing permission returns a structured blocker with actions, not a generic failure.

## Security

- The model and plugins cannot request OS permission directly.
- Helper auth and OS prompt state never enter a prompt.
- Request/recheck/test/open-settings are audited.
- System permission requests are never bundled with unrelated consent.
- Background and automation sessions receive a stricter policy and cannot inherit interactive grants silently.

## Packaging

- Usage descriptions and entitlements are explicit.
- Helper and app identity are stable within the chosen signing lane.
- Ad-hoc open-source artifacts remain clearly labeled as unnotarized.
- Developer ID/notarization is a separate release gate requiring external credentials.

