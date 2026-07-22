# ADR 0009: Desktop trusts only its own local origin

- Status: accepted
- Date: 2026-07-22

## Decision

The Electron application starts AdPilot's server on a random loopback port and treats only URLs with an exact matching `URL.origin` as internal. It uses context isolation, renderer sandboxing and disabled Node integration, denies permission requests, and opens external links only for `http:` and `https:` URLs.

Desktop startup reads optional environment overrides solely from the Electron user-data directory. It does not load a `.env` file from the caller's working directory. The packaged release disables certificate auto-discovery (`CSC_IDENTITY_AUTO_DISCOVERY=false`) and uses electron-builder's certificate-free ad-hoc macOS identity (`identity: "-"`). This seals the app bundle for integrity verification without a Developer ID or Team ID. The release is not notarized and bundles project and third-party license notices with the application.

## Consequences

- Prefix checks such as `startsWith(origin)` are not authorization; lookalike origins and malformed URLs do not navigate the privileged renderer.
- `file:`, custom schemes and other non-web links are not delegated to the operating system.
- A certificate-free ad-hoc signed DMG is a valid open-source distribution artifact and can pass local `codesign --verify`, but it is not Apple-trusted and can trigger Gatekeeper. Developer ID signing and notarization remain a separately authorized release operation.
- Runtime control state comes from the server/Computer Use runtime rather than optimistic desktop state, so an unavailable or paused controller is not displayed as running.
