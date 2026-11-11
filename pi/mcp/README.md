# Pi delivery tools over MCP

`server.mjs` serves the same 17 delivery tools Pi registers (`scaffold_tasks`, `execute_and_review`,
`checkpoint_verified_task`, `validate_feature`, the recovery tools, `review_changes`, ...) to any MCP host.
It loads the host-neutral definitions in `pi/agent/extensions/*/tools.mjs`; nothing is duplicated.
The adapter logic is `pi/agent/lib/host/mcp.mjs` (dependency-free and unit-tested); this directory only
wires in the MCP SDK, TypeBox and a JSON Schema validator.

```sh
npm ci --prefix pi/mcp
node pi/mcp/server.mjs          # stdio; runs in the current directory, which must be the target repository
```

Claude Code: `claude mcp add pi-delivery -- node /absolute/path/to/pi/mcp/server.mjs`, run from the repository
you are delivering in. VS Code: add the same command to `.vscode/mcp.json` (`"type": "stdio"`).
The external CLIs (`scaffold`, Conductor, Executor, Review) must be on `PATH`, as they are for Pi.

## What the adapter does that Pi did implicitly

- **Validates arguments.** Pi checked them against the TypeBox schema before `execute`; the MCP SDK's server
  does not. The adapter validates every call (`ajv`) and refuses to be built without a validator.
- **Approvals via elicitation.** `approve_feature_direction`, `approve_delivery_amendment` and
  `adopt_foreign_commits` ask the human through MCP elicitation, so the host shows the prompt and the
  agent cannot answer it. Only an explicit `accept` with `approve: true` counts. A client without
  elicitation support, a thrown error, or any other answer is a refusal: the tools fail closed.

## What this does NOT give you yet

**The trust model.** In Pi the orchestrator cannot edit source; only these tools can. Claude Code and
Copilot have their own edit tools, so connecting this server does not stop an agent bypassing
`execute_and_review`. The ledger and checkpoint checks will still detect stray edits as drift, but
prevention needs host configuration (deny rules / a `PreToolUse` hook for Claude Code). That is the next step.

Also unverified: behaviour under a real Claude Code or VS Code session (the tests use the SDK's own
client), and approval UX in either. Headless runs cannot approve; they need a separate design.
