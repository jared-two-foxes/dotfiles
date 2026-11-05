# Pi Conductor extension

`index.ts` registers the user-invoked `/conductor <request-file>` command.
It runs a standalone `conductor.request/v2` JSON file and reports the runner
status and retained log directory. Relative file paths resolve from Pi's
current working directory. Install `conductor` on PATH or set `CONDUCTOR_BIN`.

`pi/agent/lib/conductor/client.mjs` builds Conductor request envelopes, invokes the CLI, validates
runner responses, and reads retained command output. The sibling
[Execute and Review extension](../execute-and-review/README.md) imports that
client and registers the agent-facing delivery tools. Use those tools for
Scaffold-bound work that requires independent review and a verified checkpoint.

For copy-based installs, include `pi/agent/lib/conductor/` under the agent
home's `lib/` directory.

The legacy `meaningful-test-condition.mjs` path forwards older retained plans
to the validator in the shared delivery-state library.
