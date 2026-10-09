---
name: executor
description: Use when preparing a deterministic change set for the standalone executor CLI. Explains the current operations JSON format, safety constraints, and how to hand it off without applying changes.
---

# Executor — Prepare Change Operations

This skill describes how to **prepare** input for the standalone [executor CLI](https://github.com/jared-two-foxes/executor). It is reusable by any agent that needs to author executor-compatible operations, not just the Design agent.

**The executor repository (its README and Rust input types) is the source of truth.** This skill documents the interface known at the time of writing. If a newer installed executor or repository version differs, consult its documentation rather than inventing an input format.

## Invocation

From the **root of the target Git repository**, executor accepts a UTF-8 JSON file or stdin:

```sh
executor apply changes.json
executor apply -
```

A JSON document has exactly one top-level `operations` array. Operations run sequentially and modify the working tree only, without staging or committing. Existing changes are allowed. **Failure is not atomic:** executor stops on the first failure and retains earlier successful operations and any changes left by the failed operation.

## Supported input

```json
{
  "operations": [
    {
      "type": "create_file",
      "path": "notes.txt",
      "content": "Hello\n"
    },
    {
      "type": "patch",
      "source": {
        "type": "inline",
        "patch": "diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-before\n+after\n"
      }
    }
  ]
}
```

Supported operations (field names and shapes are significant):

| Type | Fields | Semantics |
|---|---|---|
| `patch` | `source: {"type":"inline","patch":"<full Git diff>"}` or `{"type":"file","path":"<relative path>"}` | Apply a Git unified diff to the working tree |
| `create_file` | `path`, `content` | Create a new UTF-8 file; fails if it exists |
| `replace_file` | `path`, `expected_sha256`, `content` | Replace only if the existing file matches the verified lowercase SHA-256 |
| `delete_file` | `path` | Delete an existing file |
| `move_file` | `from`, `to` | Move a file; destination must not exist |
| `create_directory` | `path` | Create a directory; parent must exist |
| `delete_directory` | `path` | Remove an empty directory |
| `move_directory` | `from`, `to` | Move a directory; destination must not exist |

For `patch`, the `source` object has a `type` of `inline` or `file`. An inline patch contains the **complete** Git diff as a JSON string, with newline characters escaped. A file source refers to a patch file that already exists; its path is resolved relative to the current working directory.

## Authoring rules

1. Inspect the **exact current source files** before generating a patch. Never guess line numbers, hunk context, file contents, or a SHA-256.
2. Prefer inline `patch` operations for editing existing files. Use dedicated create/move/delete operations when they are clearer. For `replace_file`, compute `expected_sha256` from actual bytes; if unavailable, choose a patch or ask for the file.
3. Include the complete patch or complete UTF-8 file content. Never emit pseudocode, ellipses, placeholders, or partial snippets as an executable operation.
4. Order operations by dependency (create parent directories first; move files before deleting their old parent directories).
5. Keep every path relative to the repository root. Do not target absolute paths, `..`, `.git`, symlinks or paths outside the repository. Symlink and submodule patches are unsupported.
6. Keep requirements, rationale, architectural decisions, and acceptance criteria **outside** the executor JSON. Executor consumes operations, not a design specification.
7. Produce valid JSON only, without extra schema fields. If the change cannot be represented reliably with the available context, say so and ask for the missing source or propose a smaller coherent slice.
8. Do not claim operations were executed, validated or successful merely because they were generated.

## Handoff

Return the JSON in a separate fenced block, accompanied by a short description of what it changes and how to pass it to `executor apply -` or save it as a file. Do not execute it unless the calling agent's role and the user **explicitly** authorize execution; for read-only design roles, never invoke executor.

Executor reports JSON with `success`, `operations_applied`, and, on operation failure, `failed_operation` (zero-based) and `error`. A nonzero exit code indicates failure. On failure, inspect the working tree before attempting another application because partial changes may remain.
