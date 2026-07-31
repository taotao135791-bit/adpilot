# Extension Ecosystem

AdPilot separates discovery from execution. A public registry entry, source
repository, or skill example is research input—not an install approval.

## Current Sources

The ecosystem review tracks primary publisher sources:

- [OpenAI Plugins](https://github.com/openai/plugins) for current Codex plugin
  packaging patterns and richer skill/MCP examples.
- [Anthropic Agent Skills](https://github.com/anthropics/skills) for portable
  `SKILL.md` structure and progressive-disclosure examples. Licenses vary by
  skill and must be checked per directory.
- [Official MCP Registry](https://modelcontextprotocol.io/registry/about) for
  discovery metadata. The registry is in preview and deliberately
  unopinionated; it is not a code-security or product-approval signal.

No third-party source is vendored automatically. Importing any content requires
an immutable revision, license review, provenance record, privacy review, and
local validation.

## Candidate Integrations

The desktop plugin page shows discovery-only cards for:

- GitHub's official MCP server
- Google's hosted Drive MCP server
- Figma's official MCP server

These cards are compiled metadata and have no install or execute action.
GitHub should start with read-only, lockdown, and a minimal tool set. Google
Drive is still a Developer Preview and requires OAuth/project plus Workspace
governance review. Figma client access is restricted and write-to-canvas must
remain disabled during an initial read-only integration.

## Promotion Gate

A candidate can move to `plugins/curated` only after all of the following:

1. Resolve an official artifact to an immutable revision or digest.
2. Review its license, source, transitive dependencies, install behavior, and
   secret handling.
3. Translate its tools into a minimal allow-list with read-only defaults.
4. Declare exact filesystem, network, credential, browser, and computer-use
   permissions.
5. Run it out of process with a scrubbed environment, resource limits,
   cancellation, timeouts, output caps, and audit coverage.
6. Test malformed input, permission denial, prompt injection, replay,
   cancellation, partial failure, and upgrade permission diffs.
7. Package the reviewed bytes, compute integrity, and sign them with the
   release key outside the repository. Never commit a signing private key.

Mutable tools remain unavailable until they route through AdPilot's normal
plan, guardrail, explicit approval, execution, verification, and audit path.
