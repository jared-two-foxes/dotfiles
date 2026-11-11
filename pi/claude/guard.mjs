#!/usr/bin/env node
// Claude Code PreToolUse hook: applies the delivery guard policy (pi/agent/lib/guard) to a tool call.
//
//   deny  -> exit 2 with the reason on stderr (Claude sees it as the denial)
//   ask   -> exit 0 with a PreToolUse `ask` decision, so the human confirms
//   pass  -> exit 0, no output (Claude Code's own permission flow decides; this hook never grants access)
//
// Registered with onFailure "block" (hooks/hooks.json): a crash, timeout or missing script blocks the call
// instead of letting it through, which is Claude Code's default for a failing hook.
import { decide } from "../agent/lib/guard/index.mjs";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let event;
try {
  event = JSON.parse(raw);
} catch {
  process.stderr.write("pi-delivery guard: could not read the hook input; blocking the call.\n");
  process.exit(2);
}

const verdict = decide(event);
if (verdict.decision === "deny") {
  process.stderr.write(`${verdict.reason}\n`);
  process.exit(2);
}
if (verdict.decision === "ask") {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: verdict.reason,
    },
  })}\n`);
}
process.exit(0);
