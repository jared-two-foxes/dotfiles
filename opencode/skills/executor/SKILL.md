---
name: executor
description: Use when preparing a deterministic change set for the standalone executor CLI. Explains the current operations JSON format, safety constraints, and how to hand it off without applying changes.
---

# Executor — Prepare Change Operations

This skill describes how to **prepare** input for the [executor](https://github.com/jared-two-foxes/executor) operation schema. OpenCode's Design workflow passes this exact input to the shared [Conductor](https://github.com/jared-two-foxes/conductor) CLI via `execute_and_review`. It is reusable by any agent that needs to author executor-compatible operations, not just the Design agent.

**The executor repository (its README and Rust input types) is the source of truth.** This skill documents the interface known at the time of writing. If a newer installed executor or repository version differs, consult its documentation rather than inventing an input format.

## Invocation

From the **root of the target Git repository**, executor accepts a UTF-8 JSON file or stdin:

```sh
executor apply changes.json
executor apply -
```

A JSON document has exactly one top-level `operations` array. Operations run sequentially and modify the working tree only, without staging or committing. Existing changes are allowed. **Failure is not atomic:** executor stops on the first failure and retains earlier successful operations and any changes left by the failed operation.

## Supported input

A JSON document has one top-level `operations` array. Operations run in order and affect the working tree only; they do not stage or commit changes.

Use `edit_file` for exact-text changes to an existing file:

```json
{
  "operations": [
    {
      "type": "edit_file",
      "path": "src/example.rs",
      "edits": [
        {"oldText": "let old = 1;", "newText": "let new = 2;"},
        {"oldText": "fn old_name()", "newText": "fn new_name()"}
      ]
    }
  ]
}
```

Supported operations (field names and shapes are significant):

| Type | Fields | Semantics |
|---|---|---|
| `edit_file` | `path`, `edits: [{oldText, newText}]` | Apply literal exact-text replacements to an existing regular UTF-8 file |
| `create_file` | `path`, `content` | Create a new UTF-8 file; fails if it exists |
| `replace_file` | `path`, `expected_sha256`, `content` | Replace only if the existing file matches the verified lowercase SHA-256 |
| `delete_file` | `path` | Delete an existing file |
| `move_file` | `from`, `to` | Move a file; destination must not exist |
| `create_directory` | `path` | Create a directory; parent must exist |
| `delete_directory` | `path` | Remove an empty directory |
| `move_directory` | `from`, `to` | Move a directory; destination must not exist |

For `edit_file`, `edits` must be non-empty. Every `oldText` must be non-empty and occur exactly once in the file contents at the start of that operation; overlapping occurrences also make a match ambiguous (`aa` in `aaa` is ambiguous). All edits resolve against that same snapshot, after any earlier operations. Intersecting ranges are rejected; adjacent ranges are allowed, and input order does not affect the result. Replacements are literal: whitespace, Unicode, case, and line endings are not normalized. Empty `newText` deletes the matched text; identical replacements are valid.

The target must already exist as a regular UTF-8 file. Decoding is strict UTF-8; valid BOMs, NUL characters, and mixed line endings are accepted and untouched content is preserved. All edits are validated and assembled before the file is written once, preserving permissions. Validation or decoding failures leave the file unchanged; an OS truncation/write failure may still leave partial changes. `edit_file` never creates a file.

The `patch` operation has been removed, with no fallback. Never emit `patch` or unified-diff source fields: a `patch` anywhere in the input is rejected during parsing before any operation executes. Use `replace_file` for hash-guarded whole-file replacement and the dedicated create/delete/move operations for structural changes.

## Authoring rules

1. Inspect the exact current source contents before preparing operations. Never guess `oldText` or file contents.
2. Use `edit_file` for in-place text changes. Each non-empty `oldText` must be a unique literal in the file at the start of that operation; use a larger anchor if needed. Batch only non-overlapping edits that can all be resolved against the same original contents.
3. Use `replace_file` for hash-guarded whole-file replacement, calculating `expected_sha256` from actual bytes. Use create, delete, move, and directory operations for structural changes. The `patch` operation has been removed; do not emit unified diffs or patch-source files.
4. Represent multi-file changes as explicit operations, one target file per operation. Include the complete JSON; never emit pseudocode, ellipses, or placeholders.
5. Order operations by dependency (create parent directories first; move files before deleting their old parent directories).
6. Keep every path relative to the repository root. Do not target absolute paths, `..`, `.git`, symlinks, or paths outside the repository; executor enforces its repository-boundary and symlink protections.
7. Keep requirements, rationale, architectural decisions, and acceptance criteria **outside** the executor JSON. Executor consumes operations, not a design specification.
8. Produce valid JSON only, without extra schema fields. If a change cannot be represented reliably with supported operations, ask for missing context or propose a smaller coherent slice.
9. Do not claim operations were executed, validated, or successful merely because they were generated.

## Handoff

Return the JSON in a separate fenced block with a short description. In OpenCode Design, after **separate explicit execution approval**, pass this exact JSON as the `input` field of `execute_and_review`. Do not run `executor apply` or `conductor run` directly from Design. Outside OpenCode, a caller may use `executor apply -` or wrap the operations in a Conductor workflow request. Never execute without authorization.

Executor reports JSON with `success`, `operations_applied`, and, on operation failure, `failed_operation` (zero-based) and `error`. A nonzero exit code indicates failure. On failure, inspect the working tree before attempting another application because partial changes may remain.
