# Pi delivery tools over MCP

`server.mjs` serves the same 17 delivery tools Pi registers (`scaffold_tasks`, `execute_and_review`,
`checkpoint_verified_task`, `validate_feature`, the recovery tools, `review_changes`, ...) to any MCP host.
It loads the host-neutral definitions in `pi/agent/extensions/*/tools.mjs`; nothing is duplicated.
The adapter logic is `pi/agent/lib/host/mcp.mjs` (dependency-free and unit-tested); this directory only
wires in the MCP SDK, TypeBox and a JSON Schema validator.

Only `package.json` and `package-lock.json` are committed; the dependencies are downloaded at setup:

```sh
npm ci --prefix pi/mcp          # the Windows installers run this via install/mcp.ps1
node pi/mcp/start.mjs           # stdio; runs in the current directory, which must be the target repository
```

`start.mjs` is the entry point to give a host. If the dependencies are missing it prints the one-line fix on
stderr and exits 1, rather than failing with a module-resolution stack trace.

Claude Code: `claude mcp add pi-delivery -- node /absolute/path/to/pi/mcp/start.mjs`, run from the repository
you are delivering in. VS Code: add the same command to `.vscode/mcp.json` (`"type": "stdio"`).
The external CLIs (`scaffold`, Conductor, Executor, Review) must be on `PATH`, as they are for Pi.

## Using it from Pi (opt-in, experimental)

Pi has a built-in MCP client. The `delivery-mcp` extension can register this server for a session, so Pi
uses the same tool code as other hosts:

```sh
PI_DELIVERY_TRANSPORT=mcp pi
```

- **Default is unchanged.** Without the variable Pi registers all 17 tools natively, as before.
- **Safe fallback.** Before choosing MCP, Pi's transport check actually starts the server
  (`node start.mjs --check` loads the whole module graph and exits). A missing file, missing or partial
  dependencies (including ones the direct packages need), a Node too old for the SDK, or no `node` on `PATH`
  therefore all fall back to the native tools with a warning that names the cause. The result is cached, so
  one Pi session spawns one check. `PI_DELIVERY_MCP_SERVER` points at `start.mjs` for non-standard layouts.
  Both registration paths use `deliveryTransport()` in `pi/agent/lib/host/pi.mjs`, so they always agree.
  **Not covered:** a server that starts fine and dies later in a session. Pi shows it as disconnected and
  reconnects on the next call; the native tools are not restored mid-session (Pi exposes no connection state
  to extensions, only each server's config).
- **Approvals stay native.** Pi 1.5.2's MCP client declares `{"roots":{}}` and no `elicitation`, so approvals
  over MCP would always fail closed. The three tools marked `interactive` (`approve_feature_direction`,
  `approve_delivery_amendment`, `adopt_foreign_commits`) therefore register natively and the server omits them
  (`PI_DELIVERY_MCP_OMIT_INTERACTIVE=1`, set by the extension). This is safe because approvals are written to
  the Scaffold ledger and every other tool reads them back from there; no state is shared in memory.
- **Settings the extension applies.** `exposure: "direct"` (Pi's default `codemode` would hide the tools from
  the model), `timeout: 3600` (Pi's 60 s default would cut off a 30-minute workflow), and `cwd: "."` (resolved
  against Pi's session directory, i.e. the repository being delivered). The server also sends a progress
  heartbeat every 15 s to clients that ask for progress; Pi resets its timeout on progress.
- **Tool names differ.** MCP tools reach the model as `mcp__pidelivery__<tool>` (for example
  `mcp__pidelivery__execute_and_review`), while the approval tools keep their bare names. `SYSTEM.md` and the
  skills still say `execute_and_review`; whether a model maps that reliably is untested, which is why this is
  opt-in. Do not rewrite the skills until it has run end to end in a real session.

Verified against real Pi 1.5.2 without a model (extensions loaded explicitly, `PI_DELIVERY_TRANSPORT=mcp`):
the server registers and connects; Pi's tool list becomes 14 `mcp__pidelivery__*` tools plus the 3 native
approval tools; the server runs in the session directory; with the variable unset all 17 tools are native; with
a missing server path, or a server whose direct dependencies are present but which cannot start, it falls
back to all 17 native. **Not verified:** an actual tool call through Pi's MCP
client (needs a model), and approvals and long runs in a live session.

## What the adapter does that Pi did implicitly

- **Validates arguments.** Pi checked them against the TypeBox schema before `execute`; the MCP SDK's server
  does not. The adapter validates every call (`ajv`) and refuses to be built without a validator.
- **Approvals via elicitation.** `approve_feature_direction`, `approve_delivery_amendment` and
  `adopt_foreign_commits` ask the human through MCP elicitation, so the host shows the prompt and the
  agent cannot answer it. Only an explicit `accept` with `approve: true` counts. A client without
  elicitation support, a thrown error, or any other answer is a refusal: the tools fail closed.

## What this does NOT give you yet

**The trust model.** Connecting this server only *offers* the delivery tools; on its own it does not stop an
agent using the host's own edit tools instead of `execute_and_review`. Be precise about what that means: in Pi
today the rule "never use direct edit/write" is an instruction in `SYSTEM.md`, and **nothing in Pi enforces
it**. What the code does enforce is detection: the ledger and `checkpointHistory()` flag any commit that is
not an authenticated checkpoint. For Claude Code there is now a guard that *prevents* direct edits and unsafe
shell commands while a delivery is active; see [`../claude/README.md`](../claude/README.md).

Also unverified: behaviour under a real Claude Code or VS Code session (the tests use the SDK's own
client), and approval UX in either. Headless runs cannot approve; they need a separate design.
