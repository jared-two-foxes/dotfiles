---
name: conductor
description: >
  Understand or prepare standalone Conductor v2 command lists, success
  evaluators, runner results, and retained logs.
---

# Conductor runner

Use this skill for the generic runner. For Scaffold-bound implementation,
verification, independent review, or checkpoint recovery, use
/skill:execute-and-review and its native delivery tools.

### Prepare a request

A `conductor.request/v2` JSON request supplies an existing absolute
`working_directory`, an ordered `commands` array, and optionally an existing
absolute `output_directory` for the parent of the run's log directory.

Each command has `name`, `program`, and `args`. Keep the executable and each
argument separate. Conductor launches the executable directly. If a command
requires shell syntax, specify the available shell explicitly as the program.

Conductor runs commands in order and stops at the first non-passing result.
Without a `success_condition`, the command must exit zero. To apply a semantic
check, supply `success_condition: {program, args}`. The evaluator can use the
following environment variables:

- `CONDUCTOR_COMMAND_EXIT_CODE`
- `CONDUCTOR_COMMAND_STDOUT_PATH` and `CONDUCTOR_COMMAND_STDERR_PATH` for complete output
- `CONDUCTOR_COMMAND_INDEX` and `CONDUCTOR_COMMAND_NAME`

The evaluator's zero exit lets the list advance. If the original command must
also succeed, the evaluator must check its exit code explicitly.

### Run and inspect

The Conductor extension provides the user-invoked `/conductor <request-file>`
command. It reports the runner status and log directory. Relative request-file
paths resolve from Pi's current working directory.

Use the structured result to locate the command that stopped the list. The
result's `output_directory` identifies the per-run log directory. For complete
output, use each command's `stdout_path` and `stderr_path`; inline previews may
be truncated. A runner result describes command execution. Task completion and
review approval are interpreted by the delivery workflow.

See extensions/conductor/README.md for the Pi integration.
