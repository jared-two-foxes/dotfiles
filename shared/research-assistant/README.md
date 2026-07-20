# Research Assistant Prompt Layout

- `shared/research-assistant/core.md` is the canonical shared behavioral
  contract.
- `pi/agent/SYSTEM.md` is the pi
  runtime wrapper. It mirrors the shared contract and adds pi-specific tool
  and runtime rules.
- `prompts/research-assistant.prompt.md` is the VS Code Copilot prompt
  wrapper. It mirrors the shared contract and adds prompt frontmatter plus
  the `## Task` block expected by prompt files.

Update the shared core first, then propagate the same behavioral changes to
the wrappers. The wrappers are intentionally thin and environment-specific;
the shared core is the source of truth for persona and policy.
