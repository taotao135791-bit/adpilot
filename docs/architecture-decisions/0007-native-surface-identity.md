# ADR 0007: every visual action is bound to native surface identity

Caller-declared application and domain constraints are authorization intent, not evidence of the active foreground surface. A platform `NativeSurfaceAdapter` resolves active application, window title, PID, window bounds and screen bounds. Its normalized identity produces a surface fingerprint.

Each action is checked against the captured window bounds and the fingerprint attached to its screenshot. The runtime resolves the identity again immediately before native execution. A changed application, process, window, bounds, display scale or authorized visual identity returns the typed `SURFACE_CHANGED` blocker and no action occurs.

macOS has the first complete implementation. Windows and Linux use the same interface and fail closed until their native adapters can provide equivalent evidence.
