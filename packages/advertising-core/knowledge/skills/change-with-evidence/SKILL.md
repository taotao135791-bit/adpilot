---
name: change-with-evidence
description: Plan and implement repository changes with bounded scope, reversible checkpoints, evidence-based validation, and privacy checks. Use when asked to build, fix, refactor, or modify code in a repository.
---

# Change With Evidence

Implement the smallest coherent change that satisfies the request, preserves
unrelated work, and leaves evidence another engineer can verify.

## Establish the Boundary

1. Read repository instructions and inspect the relevant implementation,
   tests, configuration, and recent diff.
2. State any assumption that would materially change behavior or authority.
3. Identify data, credentials, generated files, protected paths, and external
   systems that must stay outside the change.
4. Prefer read-only discovery before mutation. Do not broaden the task merely
   because adjacent cleanup is available.

## Implement Safely

1. Preserve user changes and avoid destructive version-control operations.
2. Create a recoverable checkpoint before risky or repository-wide writes when
   the harness supports it.
3. Reuse existing abstractions and dependency versions before adding new ones.
4. Validate inputs at trust boundaries and fail closed when authority,
   identity, or target scope is ambiguous.
5. Keep secrets out of source, logs, fixtures, screenshots, command arguments,
   and generated artifacts.
6. Make cancellation, retries, partial failure, and audit failure explicit for
   long-running or state-changing operations.

## Validate in Layers

Run the narrowest relevant checks first, then expand in proportion to risk:

1. Exercise the changed behavior and its failure path.
2. Run focused tests for the affected module.
3. Run type checking, linting, generated-file checks, or builds that cover the
   changed contract.
4. Scan the final diff for credentials, private identifiers, unrelated files,
   accidental generated output, and misleading documentation.

Do not claim a check passed unless its completed output was observed. Separate
pre-existing failures from regressions introduced by the change.

## Hand Off

Lead with the outcome. Name the behavior changed, the important safety
boundary, the validation performed, and any remaining limitation. Reference
commits or artifacts when available.
