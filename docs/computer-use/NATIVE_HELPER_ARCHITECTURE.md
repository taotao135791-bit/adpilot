# Native Helper architecture

## Trust boundary

The model never receives a macOS API handle, helper token, process environment,
browser cookie, or arbitrary native command channel.

```text
Pi tool request
  -> tool schema
  -> policy + advertising guardrail
  -> approval authority (for mutations)
  -> Computer Runtime (one atomic action)
  -> authenticated NativeComputerHost
  -> framed child stdin/stdout
  -> AdPilot native helper
  -> ScreenCaptureKit / CoreGraphics / Accessibility
  -> typed result + audit
```

The helper has no network listener and no model or advertising code. It accepts one
authenticated parent over inherited pipes. Its environment is reduced to a small
locale/temporary-directory allowlist plus an ephemeral token.

## Process lifecycle

- Electron resolves the helper from a stable packaged resource path. Development may
  use an explicit absolute override or the repository build output.
- A single host actor owns the child process. Permission checks, capture, Live View and
  runtime actions reuse that actor rather than spawning permission principals.
- The host performs a version/capability handshake before making the actor available.
- Requests have bounded length, correlation ID, monotonically increasing sequence,
  deadline and one-time response correlation.
- Disconnect, malformed output, unexpected sequence and timeout terminate the actor.
- An input request whose outcome cannot be authenticated is `OUTCOME_UNKNOWN` and is
  never retried automatically.
- Restart creates a new token and handshake; old messages cannot be replayed.

## Native responsibilities

The helper owns:

- TCC status/request and Privacy settings navigation;
- display/window/frontmost metadata;
- window/display/region capture;
- app activation and window focus;
- coordinate conversion at the native surface boundary;
- atomic pointer, keyboard, scroll, drag and wait operations;
- Accessibility snapshots and focused-element metadata when authorized;
- user-input observation used to yield control.

It does not own:

- prompts or model calls;
- task planning;
- account/campaign logic;
- approval decisions or tokens;
- credentials, browser cookies or API keys;
- retries for advertising mutations.

## Packaging identity

The main application identity is `com.adpilot.desktop` and the product name is
`AdPilot`. Development output is ad-hoc signed unless a Developer ID is supplied.
Ad-hoc signing can verify bundle integrity but is not notarization and is not claimed
as Apple trust.

The helper is copied to a deterministic application resource path and is not exposed
as a second user-launched application. Packaging checks must verify that it is
executable, that its hash is stable within the artifact, and that the `.app` passes
`codesign --verify --deep --strict`.

