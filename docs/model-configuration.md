# Model configuration

AdPilot uses Pi's provider registry and model objects. Open the gear menu in the web console or native app to configure language, appearance, model routing, provider credentials, OAuth, dedicated GUI grounding, and visual verification.

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

The Computer Use settings page supports an OpenAI-compatible UI-TARS endpoint and a separate visual-verification endpoint:

```dotenv
ADPILOT_GUI_BASE_URL=http://127.0.0.1:8000/v1
ADPILOT_GUI_API_KEY=...
ADPILOT_GUI_MODEL=ui-tars-1.5
ADPILOT_GUI_STRONG_MODEL=ui-tars-1.5
ADPILOT_GUI_TIMEOUT_MS=20000

ADPILOT_VERIFY_BASE_URL=http://127.0.0.1:8001/v1
ADPILOT_VERIFY_API_KEY=...
ADPILOT_VERIFY_MODEL=vision-verifier
ADPILOT_VERIFY_TIMEOUT_MS=20000
```

The dedicated GUI provider is tried before PiVision. Strong GUI routing is used after repeated or low-confidence failures. When the dedicated endpoint is absent or fails, an authenticated image-capable Daily/Deep code model is the bounded fallback. Verification is configured independently and otherwise uses the image-capable Deep code model. If neither path is available, conversation and analysis remain enabled while Computer Use is disabled.

Every provider returns one provider-independent `VisualAction`; UI-TARS never owns the task loop. Invalid action/verifier JSON gets exactly three structured-output passes: normal generation, same-model repair using validation issues, then strong-model repair. Exhaustion becomes a typed blocker rather than free-form text.

## Runtime controls

```dotenv
ADPILOT_WORKSPACE=/absolute/private/workspace
ADPILOT_APPROVAL_SECRET=<32-or-more-random-characters>
ADPILOT_HOST=127.0.0.1
ADPILOT_PORT=4317
ADPILOT_NO_OPEN=1
```

If `ADPILOT_APPROVAL_SECRET` is absent, AdPilot generates a private local secret. `.env` is loaded by the Node 22 CLI. Values saved through Settings override matching model environment variables on the next launch. `adpilot doctor` reports selected model names and whether chat and visual capability are ready without printing credentials.
