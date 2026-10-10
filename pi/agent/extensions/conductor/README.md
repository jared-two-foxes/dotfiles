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
```

If Pi already uses this dotfiles directory as its agent home, no copy is
necessary. Restart Pi after changing extensions.

Install `conductor` on PATH (the dotfiles Windows installer already handles
it), or set `CONDUCTOR_BIN` to its executable path. Load
`/skill:conductor` for the design-first, approval-gated workflow. The
existing `/skill:tdd` is independent and remains available.

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
