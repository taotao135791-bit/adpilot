# ADR 0008: Product-owned pure-vision browser boundary

- Status: accepted
- Date: 2026-07-22

## Decision

AdPilot owns a client-scoped browser session and an in-process Computer Use plugin. Advertising platforms are operated only through active-window screenshots, bounded multimodal reasoning, single coordinate actions, native mouse/keyboard input, and independent screenshot verification.

Advertising APIs, advertising-account OAuth, DOM/selectors, accessibility trees, CDP, WebDriver, browser storage, cookies, password handling, and automated login are outside the product authority boundary.

The plugin must bind every mutation to an immutable visual execution plan, current native browser session, screenshot-derived account fingerprint, allowed ROI, and two independent visual confirmations. Full screenshots remain local; only masked task ROIs may leave the device. Local-only privacy mode forbids remote image providers.

## Consequences

- A changed process, window, profile, account, campaign, page, value, target, ROI, or model disagreement stops execution and requires a new preparation/approval.
- Low-confidence table cells and identity fields are blockers, never guessed inputs.
- Ordinary users configure Fast and Deep models and see automatic Computer Use health. Provider protocol details live behind advanced settings.
- Static architecture tests reject production imports or calls that would create a DOM/API execution path.
- Logged-in-browser validation requires local user setup and is reported separately from corpus, offline prediction, and live-model evaluation.
