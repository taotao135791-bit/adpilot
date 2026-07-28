# macOS permission model

## Principals

macOS privacy authorization belongs to the code/process identity that calls the
protected API. AdPilot therefore reports both the application identity and the helper
PID/path that performed a check. A Terminal-launched development binary and a
packaged `AdPilot.app` are not treated as interchangeable authorization evidence.

## Status vocabulary

```ts
type PermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "requires-restart"
  | "helper-unavailable"
  | "unknown";
```

Boolean compatibility fields may be returned internally, but the Permission Center
must render the status vocabulary above and a check timestamp.

## Required entries

| Permission/capability | Native source of truth | Test |
| --- | --- | --- |
| Screen Recording | CoreGraphics preflight/request plus a real bounded capture | Capture thumbnail without transmitting it to a model. |
| Accessibility | `AXIsProcessTrustedWithOptions` | Non-destructive focus/pointer capability probe. |
| Files and Folders | Product sandbox/path broker | Read/write only product-owned test file. |
| Browser Control | Managed profile and native surface lease | Validate PID/profile/window/application. |
| Notifications | Electron/macOS notification status where available | Deliver an opt-in local test notification. |
| Keychain | Credential broker | Store/read/delete a generated test secret without logging it. |
| Native Helper | Authenticated handshake and capability set | Spawn, hello, status, shutdown. |
| Background Service | Desktop runtime lifecycle | Close/reopen window while the owned runtime remains healthy. |

## Flow

1. First launch explains Screen Recording, Accessibility, managed browser isolation and
   approval gating before a task fails.
2. `Recheck` is read-only and never opens a prompt.
3. `Request` calls only the selected native permission API.
4. `Open Settings` uses the documented Privacy pane URL and remains a user action.
5. `Run test` performs the smallest non-destructive proof and reports the responsible
   process.
6. Revocation immediately disables protected actions. A queued input is cancelled.
7. If macOS requires relaunch, the product reports `requires-restart`; it does not
   mislabel the permission as fully usable.

The renderer cannot mint helper credentials or call native code directly.

