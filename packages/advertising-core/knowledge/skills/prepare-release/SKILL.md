---
name: prepare-release
description: Prepare a software release with privacy scanning, generated-file checks, tests, type checking, builds, artifact verification, documentation, and an evidence-backed go or no-go decision. Use for release readiness, packaging, publishing, or deployment handoff.
---

# Prepare Release

Produce a reproducible release decision from the exact source state intended
for publication.

## Freeze the Candidate

1. Identify the branch, commit, version, target platforms, and release scope.
2. Confirm the worktree contains only intended changes.
3. Regenerate committed derived files and fail if a second generation changes
   them.
4. Review dependency and license changes.

## Check Privacy and Supply Chain

Scan tracked and staged content for credentials, private keys, tokens, personal
identifiers, internal URLs, customer data, screenshots, local paths, and
unexpected large or binary files. Inspect commit history being published when
private data may have existed in earlier commits.

Verify plugin signatures, dependency locks, artifact digests, and the absence
of signing private keys. Do not print secret values while scanning.

## Validate

Run checks in the repository's documented order:

1. focused tests for changed behavior and denial paths
2. generated-file, format, lint, and type checks
3. full unit and integration tests
4. production build and package smoke tests
5. platform-specific security or permission tests

Capture command, exit status, test count, and relevant artifact digest. Do not
reuse results from a different commit.

## Decide and Publish

Issue **go** only when required checks pass and known limitations are
documented. Otherwise issue **no-go** with the blocking evidence.

Before pushing or publishing, re-check the exact diff and remote target. Push
only the intended commit. Report commit identifiers and artifact locations
without exposing credentials or private repository metadata.
