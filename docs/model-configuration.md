# Model configuration

AdPilot uses Pi's provider registry and model objects. Open the gear menu in the web console or native app to configure language, appearance, model routing, provider credentials, and OAuth. Configuration selects two code-model roles; Computer Use derives its visual model automatically.

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

## Screenshot grounding and verification

There is no separate VLM configuration. If the daily code model accepts image input, AdPilot uses it for the first two screenshot-grounding attempts. Otherwise it uses the deep model when that model accepts images. The third attempt and before/after verification use the image-capable deep model when available. If neither selected model accepts images, conversation and analysis remain enabled while Computer Use reports that visual capability is unavailable.

The code model returns AdPilot's provider-independent `VisualAction` JSON. UI-TARS remains the native screenshot, coordinate conversion, mouse, keyboard, scroll, and action-execution layer; it does not own a second planning loop.

## Runtime controls

```dotenv
ADPILOT_WORKSPACE=/absolute/private/workspace
ADPILOT_APPROVAL_SECRET=<32-or-more-random-characters>
ADPILOT_HOST=127.0.0.1
ADPILOT_PORT=4317
ADPILOT_NO_OPEN=1
```

If `ADPILOT_APPROVAL_SECRET` is absent, AdPilot generates a private local secret. `.env` is loaded by the Node 22 CLI. Values saved through Settings override matching model environment variables on the next launch. `adpilot doctor` reports selected model names and whether chat and visual capability are ready without printing credentials.
