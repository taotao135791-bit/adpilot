# Model configuration

AdPilot uses Pi's provider registry and model objects. Open the gear menu in the web console or native app to configure language, appearance, Daily/Deep model routing, and model-provider credentials. Computer Use is built in: users do not install UI-TARS, NutJS, a grounding server, a verifier, or an MCP.

The catalog is generated from the installed Pi runtime, not maintained as a separate AdPilot allowlist. It contains the providers and static models exposed by the pinned Pi version; providers with dynamic catalogs populate them after model-provider authentication.

## Fast and Strong

```dotenv
ADPILOT_FAST_PROVIDER=openai
ADPILOT_FAST_MODEL=gpt-5-mini
ADPILOT_STRONG_PROVIDER=openai
ADPILOT_STRONG_MODEL=gpt-5.2
OPENAI_API_KEY=...
```

The provider and model can be selected directly in Settings. Daily handles conversation, routine planning, extraction and reports. Deep handles conflicts, low confidence, complex causal analysis, risk review, identity/table review and the third visual grounding attempt. Either can be a code model; no separate VLM is required. If both routes select the same image-capable model, AdPilot still makes separately audited reviewer calls instead of disabling Computer Use.

API-key providers expose only the fields they actually require, including the additional account, deployment, region, or project fields used by Bedrock, Azure OpenAI, Cloudflare, and Google Vertex. OAuth-capable model providers show a native connection flow in the GUI. This authenticates the model provider, never an advertising account. The same flow is available from the CLI:

```bash
adpilot providers
adpilot login openai-codex
adpilot logout openai-codex
```

Settings are stored in `<workspace>/.adpilot/settings.json`; Pi OAuth credentials are stored separately in `<workspace>/.adpilot/pi-auth.json`. Both are private `0600` files. The HTTP settings response contains only configured flags, credential types, and non-secret values.

## Custom compatible providers

Enterprise gateways and local inference servers (llama.cpp, Ollama, vLLM) register as custom providers in Settings → Models, or through the `ADPILOT_CUSTOM_PROVIDERS` environment variable carrying a JSON list:

```dotenv
ADPILOT_CUSTOM_PROVIDERS='[{"id":"corp-gateway","name":"Corp Gateway","baseUrl":"https://gateway.corp.example/v1","api":"openai-completions","apiKey":"gateway-secret","models":[{"id":"gpt-4o-internal"}]},{"id":"local-llama","name":"Local llama.cpp","baseUrl":"http://127.0.0.1:8080/v1","models":[{"id":"qwen3-8b","vision":true}]}]'
```

`api` is `openai-completions` (the default) or `anthropic-messages`. `apiKey` is optional for keyless local servers; the model layer then sends a placeholder bearer token. `vision: true` marks a model as image-capable so it can join the Computer Use route. Ids are lowercase slugs and must not collide with built-in Pi provider ids. Saved values live in the private settings store and the settings view exposes only `hasApiKey` per provider, never the key. Under `local-only` privacy mode a public custom endpoint is rejected on the conversational path; loopback and private-network endpoints stay exempt.

## Automatic Computer Use routing

At startup AdPilot checks the selected Pi models' declared image input, provider authentication and runtime availability. The normal production route is the authenticated image-capable Daily code model, followed by a fresh screenshot/retry and the Deep code model on the third attempt. Normal settings report Computer Use readiness, the selected visual/escalation route, independent verification, browser-session state, current permission, privacy mode, and recent screenshot-disclosure audits.

```text
image-capable Daily model through the built-in grounding adapter
  -> new screenshot and one retry
  -> image-capable Deep model on the third attempt
  -> typed blocker and stop

independent verification call
  -> Deep vision call when no advanced verifier override exists
```

Grounding emits exactly one provider-independent `VisualAction`; models never own the task loop or permissions. AdPilot validates action JSON, coordinate representation, screenshot size/DPR, native window identity, task/plan/account fingerprints, risk, permission and allowed ROI before native input. If no selected authenticated model accepts images, chat remains available while Computer Use reports that it is not ready.

Model output is also not deterministic guardrail evidence. A mutation proposal may name already-verified screenshot-backed `SharedFact` IDs for measurement reliability, campaign maturity and learning phase directly, or exact verified raw metrics/status Fact IDs from which application code deterministically derives those three verified facts. The application—not Pi, the selected code model, UI-TARS or a verifier—checks the complete lineage and recomputes the numerical change guardrail, client cap and active-experiment constraint before risk review, user approval and commit. No model setting can relax this requirement.

## Advanced developer overrides

Advanced settings support an OpenAI-compatible UI-TARS endpoint and a separate visual-verification endpoint. These are optional deployment overrides, not a normal installation requirement:

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

The Pi code-model visual route remains the zero-extra-service default. Only when a user explicitly saves a dedicated GUI endpoint does it become a higher-priority advanced override ahead of that built-in route. Strong routing is used after repeated or low-confidence failures. Verification remains a separately invoked role and otherwise uses the image-capable Deep code model.

Every provider returns one provider-independent `VisualAction`; UI-TARS never owns the task loop. Invalid action/verifier JSON gets exactly three structured-output passes: normal generation, same-model repair using validation issues, then strong-model repair. Exhaustion becomes a typed blocker rather than free-form text.

## Screenshot privacy

Every grounding, verification, account-identity and table-reader call stores the complete screenshot locally and records provider/model, screenshot id, call role, ROI, masks, locality and retention policy. When no target coordinates exist, a locator receives a browser-content crop with default masks; after a target exists, the call receives a tight target crop with surrounding pixels masked. Mutation identity uses the first reviewer as a locator, sends the second reviewer only the four account/Campaign/current-value/target regions, persists the agreed regions, and reuses them at commit. A remote provider cannot receive a full-window image. `ADPILOT_PRIVACY_MODE=local-only` blocks every remote image provider rather than silently falling back.

## Runtime controls

```dotenv
ADPILOT_WORKSPACE=/absolute/private/workspace
ADPILOT_APPROVAL_SECRET=<32-or-more-random-characters>
ADPILOT_HOST=127.0.0.1
ADPILOT_PORT=4317
ADPILOT_NO_OPEN=1
```

If `ADPILOT_APPROVAL_SECRET` is absent, AdPilot generates a private local secret. The Node 22 CLI may load `.env` from its normal local launch context; the packaged Electron application intentionally loads only `<Electron userData>/.env`, never the current working directory. Values saved through Settings override matching model environment variables on the next launch. `adpilot doctor` reports selected model names and whether chat and visual capability are ready without printing credentials.
