# Pi Conductor integration

The native Pi extension in `extensions/conductor/` registers
`execute_and_review` and sends a `conductor.request/v1` to the standalone
Rust `conductor` binary. It does not invoke executor or review-cli directly.

## Native Pi installation

Place the entire `conductor` directory (including `adapter.mjs` and
`package.json`) at:

```
~/.pi/agent/extensions/conductor/
```

For a dotfiles checkout on Windows, a copy-based installation is:

```powershell
Copy-Item -Recurse -Force .\pi\agent\extensions\conductor "$HOME\.pi\agent\extensions\conductor"
Copy-Item -Recurse -Force .\pi\agent\skills\conductor "$HOME\.pi\agent\skills\conductor"
Copy-Item -Recurse -Force .\pi\agent\skills\design "$HOME\.pi\agent\skills\design"
Copy-Item -Recurse -Force .\pi\agent\skills\executor "$HOME\.pi\agent\skills\executor"
```

If Pi already uses this dotfiles directory as its agent home, no copy is
necessary. Restart Pi after changing extensions.

Install `conductor` on PATH (the dotfiles Windows installer already handles
it), or set `CONDUCTOR_BIN` to its executable path. Pi loads `/skill:design` when implementation is requested, or you can
invoke it explicitly for the full collaborative design-first persona. It
uses `/skill:executor` to author exact operations and the native
`execute_and_review` tool to apply them after separate execution approval.
`/skill:conductor` is the lower-level execution reference. The legacy
`/skill:tdd` direct-edit workflow has been retired; TDD remains an optional
implementation strategy within Design.

Pi skills do not pin a model or establish a separate OpenCode-style agent.
The active Pi model executes the Design persona in the current conversation.

## Current limits

- Pi's Docker launcher currently mounts only selected extensions and the
  images do not ship Conductor. Native Pi is supported here; Docker needs
  a separate binary provisioning decision.
- The Pi adapter is a local copy of the tested OpenCode protocol adapter,
  because the two agent homes can be installed independently. Keep their
  protocol behavior aligned.
- Conductor does not yet prove tests executed or detect unexpected source
  modifications during verification. The adapter imposes a 15-minute
  overall subprocess timeout, not per-check deadlines.
