---
name: toolchain-detection
description: Use when an agent needs to read the project's build, test, lint, format, and typecheck commands from AGENTS.md. Call this after project-detection — PROJECT_NAME must already be set. Extracts BUILD_CMD, TEST_CMD, FMT_CHECK_CMD, FMT_FIX_CMD, LINT_CMD, TYPECHECK_CMD, and GIT_WORKFLOW from the ## Toolchain table.
---

# Toolchain Detection

Read the workspace's `AGENTS.md` and extract the toolchain configuration.

## Step 1 — Read AGENTS.md

Use the Read tool to read `AGENTS.md` from the workspace root.

## Step 2 — Locate the ## Toolchain table

Find the section headed `## Toolchain`. It contains a Markdown table with `Command` and `Value` columns.

Extract each of the following:

| Variable | AGENTS.md key |
|---|---|
| `BUILD_CMD` | `BUILD_CMD` |
| `TEST_CMD` | `TEST_CMD` |
| `FMT_CHECK_CMD` | `FMT_CHECK_CMD` |
| `FMT_FIX_CMD` | `FMT_FIX_CMD` |
| `LINT_CMD` | `LINT_CMD` |
| `TYPECHECK_CMD` | `TYPECHECK_CMD` |
| `GIT_WORKFLOW` | `GIT_WORKFLOW` |

## Step 3 — Handle absent values

Treat a command as **absent** (do not store it, do not run it) when the value is any of:
- `_(none)_`
- Blank / empty
- A note that it is "covered by" or "same as" another command

`GIT_WORKFLOW` defaults to `trunk-based` if its row is missing or blank.

## Step 4 — No toolchain table

If no usable `## Toolchain` table exists in `AGENTS.md`: stop immediately and ask the user to add one before continuing. Do not proceed without it.

## Step 5 — Report

Report the extracted values to the user in one concise message, listing each present command and the `GIT_WORKFLOW` value. Absent commands are omitted from the report.
