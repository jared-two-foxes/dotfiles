---
name: conductor
description: >
  Execute an approved, exact executor operations JSON through the Pi
  execute_and_review tool and the deterministic Conductor CLI. Use for
  design-first implementation with explicit approval, build/test checks,
  and independent review. Used by the Design implementation workflow.
---

# Conductor — design-first execution

Use this skill as the lower-level Conductor execution reference. For the
full collaborative architecture conversation, load `/skill:design` first;
that skill owns decisions, design confirmation and executor authoring.
Conductor is the sole implementation path; never substitute direct edits.

## Preconditions

- The native Pi extension `extensions/conductor/index.ts` must be loaded,
  exposing the `execute_and_review` tool. If unavailable, stop; never
  substitute direct edits or invoke Conductor manually.
- The `conductor` executable must be on PATH (or set `CONDUCTOR_BIN`).
- The target directory must be a Git repository.
- Confirm both a real build command and a real test command as arrays of
  executable and arguments. No shell syntax or invented commands.
- The Design agent must inspect the exact source before writing patches and must
  produce **complete executor operations JSON** with an `operations` array.
  Do not pass a plan, a patch-only legacy format, or pseudocode.

## Approval gates

1. Inspect the repository and discuss material design decisions with the user.
2. Present the design, fixed acceptance criteria and proposed executor JSON.
3. Obtain explicit permission **to execute**, separate from design approval.
4. Capture the full SHA from `git rev-parse HEAD` as `baseRef` once. Inspect
   `git status --porcelain`; disclose unrelated working changes. Keep the
   same base SHA and requirements across correction attempts.

## Execution

Call **only** `execute_and_review` with:

- `input`: JSON string containing the exact `operations` array.
- `requirements`: the approved design and acceptance criteria.
- `baseRef`: original full 40-character commit SHA.
- `buildCommand`, `testCommand`: executable-and-argument arrays.
- `reviewModel` (optional): independent review model.

The tool validates the Git baseline, forwards one
`conductor.request/v1` to `conductor run --request -`, and returns an
`opencode.execute_and_review.result/v1`-compatible envelope. The schema
name is historical; Pi consumes the same result contract.

- **PASSED**: report the actual checks and review; do not claim a commit was
  made or that tests ran unless the output demonstrates it.
- **NEEDS_DESIGN**: inspect current working tree and feedback. Prepare a
  minimal new executor input against the *current* state, retaining the
  original baseline and requirements. Ask before architectural changes.
- **BLOCKED**: stop, explain the environment or protocol failure and inspect
  working tree before retrying.

Maximum five total attempts, stopping after two identical failures without
progress. Never silently clean, reset, commit or push. Do not run direct
`edit`/`write` operations or call `executor`/`review-cli` to bypass the
Conductor gate.

## Limitations

Conductor currently does not prove that any tests executed or guard against
unexpected source modifications during verification. Inspect test output and
report these limitations honestly. The Pi adapter has an overall 15-minute
subprocess deadline but Conductor does not yet enforce per-check timeouts.
