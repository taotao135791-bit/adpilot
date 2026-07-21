# Model configuration

AdPilot uses Pi's provider registry and model objects. Open the gear menu in the web console or native app to configure language, appearance, model routing, provider credentials, OAuth, and Computer Use. Configuration selects three roles; it does not create three competing agent loops.

The catalog is generated from the installed Pi runtime, not maintained as a separate AdPilot allowlist. With Pi 0.80.10 it contains 36 providers and 1,072 static model entries: Amazon Bedrock, Ant Ling, Anthropic, Azure OpenAI, Cerebras, Cloudflare AI Gateway, Cloudflare Workers AI, DeepSeek, Fireworks, GitHub Copilot, Google, Google Vertex AI, Groq, Hugging Face, Kimi For Coding, MiniMax, MiniMax CN, Mistral, Moonshot AI, Moonshot AI CN, NVIDIA, OpenAI, OpenAI Codex, OpenCode Zen, OpenCode Zen Go, OpenRouter, Radius, Together, Vercel AI Gateway, xAI, Xiaomi and its three token-plan regions, Z.AI, and Z.AI Coding CN. Radius has a dynamic catalog that is fetched after authentication.

## Fast and Strong

```dotenv
ADPILOT_FAST_PROVIDER=openai
ADPILOT_FAST_MODEL=gpt-5-mini
ADPILOT_STRONG_PROVIDER=openai
ADPILOT_STRONG_MODEL=gpt-5.2
OPENAI_API_KEY=...
```

The provider and model can be selected directly in Settings. Fast handles routine planning, extraction and reports. Strong is selected for conflicts, low confidence, complex causal analysis, risk review escalation and the third visual grounding attempt.

API-key providers expose only the fields they actually require, including the additional account, deployment, region, or project fields used by Bedrock, Azure OpenAI, Cloudflare, and Google Vertex. OAuth-capable providers show a native connection flow in the GUI. The same flow is available from the CLI:

```bash
adpilot providers
adpilot login openai-codex
adpilot logout openai-codex
```

Settings are stored in `<workspace>/.adpilot/settings.json`; Pi OAuth credentials are stored separately in `<workspace>/.adpilot/pi-auth.json`. Both are private `0600` files. The HTTP settings response contains only configured flags, credential types, and non-secret values.

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

If `ADPILOT_APPROVAL_SECRET` is absent, AdPilot generates a private local secret. `.env` is loaded by the Node 22 CLI. Values saved through Settings override matching model environment variables on the next launch. `adpilot doctor` reports selected model names and whether GUI configuration is complete without printing credentials.
