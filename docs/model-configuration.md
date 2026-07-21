# Model configuration

AdPilot uses Pi's provider registry and model objects. Configuration selects three roles; it does not create three competing agent loops.

## Fast and Strong

```dotenv
ADPILOT_FAST_PROVIDER=openai
ADPILOT_FAST_MODEL=gpt-5-mini
ADPILOT_STRONG_PROVIDER=openai
ADPILOT_STRONG_MODEL=gpt-5.2
OPENAI_API_KEY=...
```

The provider name must exist in the Pi model registry and its normal credential environment variable must be present. Fast handles routine planning, extraction and reports. Strong is selected for conflicts, low confidence, complex causal analysis, risk review escalation and the third visual grounding attempt.

## GUI grounding and verification

```dotenv
ADPILOT_GUI_BASE_URL=https://your-openai-compatible-endpoint/v1
ADPILOT_GUI_API_KEY=...
ADPILOT_GUI_MODEL=your-ui-tars-model
ADPILOT_GUI_STRONG_MODEL=your-stronger-ui-tars-model
```

The endpoint must support the UI-TARS SDK request shape for grounding and OpenAI-compatible `chat/completions` with image inputs for before/after verification. The first two attempts use `ADPILOT_GUI_MODEL`; the third uses `ADPILOT_GUI_STRONG_MODEL`. If the strong name is omitted, AdPilot explicitly reports the primary model as the compatibility fallback. AdPilot invokes the grounding model for one micro-action only. It never delegates the full advertising goal to a GUI agent.

## Runtime controls

```dotenv
ADPILOT_WORKSPACE=/absolute/private/workspace
ADPILOT_APPROVAL_SECRET=<32-or-more-random-characters>
ADPILOT_HOST=127.0.0.1
ADPILOT_PORT=4317
ADPILOT_NO_OPEN=1
```

If `ADPILOT_APPROVAL_SECRET` is absent, AdPilot generates a private local secret. `.env` is loaded by the Node 22 CLI. `adpilot doctor` reports selected model names and whether GUI configuration is complete without printing credentials.
