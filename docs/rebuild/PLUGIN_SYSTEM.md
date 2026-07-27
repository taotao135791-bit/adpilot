# Plugin system

Status: implementation contract

## Trust model

A plugin is a reviewed, versioned bundle of declarative capabilities. It never receives an `AdPilotSystem`, approval token, provider secret, raw browser Profile, native helper token, or direct advertising mutation API.

Official protected components cannot be replaced:

- Advertising Core
- Shared Fact lifecycle
- Risk Reviewer
- Approval Engine
- Computer policy
- post-change verification
- audit sink

## Manifest

```ts
interface PluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  developer: string;
  description: string;
  entrypoint: string;
  tools: string[];
  skills: string[];
  uiExtensions?: string[];
  permissions: {
    filesystem?: string[];
    network?: string[];
    browser?: boolean;
    computerUse?: string[];
    secrets?: string[];
    advertisingRead?: boolean;
    advertisingMutation?: boolean;
  };
  supportedPlatforms: string[];
  integrity: string;
  signature?: string;
  review: {
    status: "approved" | "conditional" | "rejected" | "unreviewed";
    reviewedAt?: string;
    reviewer?: string;
  };
}
```

## Installation transaction

1. Resolve an exact version from the bundled/refreshable curated registry.
2. Download or copy into a private staging directory.
3. Reject traversal, symlinks escaping the bundle, oversized files, duplicate paths, and undeclared entrypoints.
4. Verify SHA-256 integrity.
5. Verify an Ed25519 signature against the trusted publisher store.
6. Validate the manifest and protected-component rules.
7. Calculate requested permissions and the diff from the installed grant.
8. Obtain user consent for the exact grant.
9. Run an isolated migration if required.
10. Atomically activate the version and record the audit event.

Unsigned bundles are rejected by default. Developer mode is explicit, visually persistent, local-only, and still isolated.

## Runtime isolation

- One supervised child/worker per active plugin, with resource limits, timeouts, crash state, and restart budget.
- Versioned host protocol and request correlation.
- The broker exposes only declared tools and grants.
- Filesystem grants resolve to canonical roots; network grants resolve to exact schemes/hosts.
- Secrets are opaque handles and can only be injected into approved destinations.
- Advertising mutation capability invokes the official plan/guardrail/approval pipeline; it is never a raw mutation function.
- Logs are size-capped and redact tokens, credentials, cookies, and authorization headers.

## Lifecycle

States:

```text
available → staging → installed_disabled → enabled
enabled → update_staged → needs_permission_review → enabled
enabled → crashed | disabled
installed_* → uninstalling → removed
```

An update that adds permission remains disabled until the diff is approved. Rollback keeps the previous verified version until the new one becomes healthy.

## Initial catalog

The product may display unavailable planned integrations only as “not yet available”, never with an Install button. The first release must contain at least one signed, read-only, actually installable bundle and exercise its tool through the broker before broader connectors are listed as installable.

## Tests

- install/update/rollback/disable/enable/uninstall;
- signature and integrity tampering;
- permission addition/removal diff;
- traversal, symlink, undeclared file, and protected-component claims;
- crash, timeout, protocol mismatch, and log redaction;
- migration success/failure rollback;
- plugin attempts to bypass advertising approval;
- restart recovery and installed-version inventory.

