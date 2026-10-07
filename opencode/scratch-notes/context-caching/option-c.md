# Option C: Advanced — Provider-Aware Cache Headers

**Effort:** 2–3 hours | **Impact:** Optimal per-provider caching | **Risk:** Low

## Overview

Dynamically generates provider-specific cache control headers based on the current model and provider. Supports Claude (explicit cache headers), OpenAI (system message caching), local Ollama (pass-through), and others.

**Note:** Option C only provides measurable benefits at extreme scale (50+ KB context, 8+ subagent invocations per run). For most use cases, Options A + B are sufficient.

## Implementation Steps

### Step C1: Create new skill: \context-cache-control\

**Location:** \skills/context-cache-control/SKILL.md\

**Create the directory:**

\\\
skills/context-cache-control/
  SKILL.md
\\\

**Create SKILL.md with this content:**

\\\markdown
---
description: Generate provider-specific cache control headers for LLM context. Supports Claude (cache_control headers), OpenAI (system message caching), and local providers (pass-through). Called by agents before invoking subagents.
---

# Context Cache Control Skill

This skill generates **provider-specific cache control directives** to maximize caching effectiveness based on the current model and provider.

## Quick Reference

| Provider | Mechanism | Cache Control Method |
|---|---|---|
| **Claude** | Explicit cache_control headers | \cache_control: {"type": "ephemeral"}\ or \"type": "pin"\ |
| **OpenAI** (GPT-4o+) | System message reuse | Automatic (no special headers) |
| **Local Ollama** | Context reuse within sequence | Pass verbatim (no headers) |
| **Anthropic** | Recursive token caching | \cache_control: {"type": "ephemeral"}\ |

## When to Use This Skill

Use this skill only if:
- Your codebase context exceeds 50 KB regularly
- You run 8+ sequential agent invocations per pipeline run
- You need to guarantee cache persistence beyond 5 minutes
- You want to generate provider-specific headers automatically

Otherwise, rely on automatic caching (Options A + B are sufficient for most tasks).

## Usage in Agents

### Detect Current Provider

Extract the current model from the agent being invoked:

\\\ash
# From pipeline-runner or another agent
MODEL=\

# Determine provider
if [[ \ == "opencode/claude"* ]] || [[ \ == "claude"* ]]; then
  PROVIDER="claude"
elif [[ \ == "opencode/gpt"* ]] || [[ \ == "gpt"* ]]; then
  PROVIDER="openai"
elif [[ \ == "ollama"* ]]; then
  PROVIDER="ollama"
else
  PROVIDER="generic"
fi
\\\

### Generate Cache Headers (Claude)

For Claude models, you can optionally include cache control headers (though automatic caching works without them):

\\\markdown
[Claude caching works automatically]

If needed, structure content with explicit boundaries:

=== CACHEABLE BLOCK (CODEBASE CONTEXT)
[codebase content]

=== NEW TASK
[task-specific work]
\\\

At the API level, when using Claude SDK:

\\\python
# Example: if the integration exposes message-level cache_control
response = client.messages.create(
  model="claude-3-5-sonnet-20241022",
  max_tokens=1024,
  messages=[
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "[STABLE BLOCK]",
          "cache_control": {"type": "ephemeral"}
        },
        {
          "type": "text",
          "text": "[NEW TASK]"
        }
      ]
    }
  ]
)
\\\

**Note:** OpenCode agents typically do not expose message-level cache_control. Automatic caching works without explicit headers.

### For OpenAI (GPT-4o+)

GPT-4o automatically caches system messages and repeated context. No special syntax needed:

\\\json
{
  "model": "gpt-4o",
  "messages": [
    {
      "role": "system",
      "content": "[STABLE AGENT INSTRUCTIONS - auto-cached]"
    },
    {
      "role": "user",
      "content": "[NEW TASK]"
    }
  ]
}
\\\

### For Ollama

Pass context verbatim. Ollama does not support explicit caching, but reusing identical context within a conversation enables automatic internal caching:

\\\
[STABLE CONTEXT]
[codebase/memory/toolchain]

[NEW TASK]
\\\

## Debugging Cache Hits

### Claude

Check response headers for cache usage:

\\\
cache_read_input_tokens: 45000
cache_creation_input_tokens: 5000
input_tokens: 2000
\\\

- **cache_read_input_tokens > 0:** Cache hit — these tokens were not reprocessed
- **cache_creation_input_tokens > 0:** Cache write — stable block was cached
- **input_tokens:** New tokens processed normally

### OpenAI (GPT-4o+)

Response usage data:

\\\json
{
  "usage": {
    "cache_creation_input_tokens": 50000,
    "cache_read_input_tokens": 0,
    "input_tokens": 2000,
    "output_tokens": 500
  }
}
\\\

- **cache_creation_input_tokens > 0:** Cache written on first call
- **cache_read_input_tokens > 0 (on subsequent calls):** Cache hit

### Ollama

Ollama does not expose cache metrics. Verify by comparing latency:
- First call with new context: higher latency
- Subsequent calls with same context: lower latency

## Implementation Checklist

- [ ] Identify if your context regularly exceeds 50 KB
- [ ] Count average agent invocations per pipeline run
- [ ] If both criteria met, implement this skill
- [ ] Test with a complex task
- [ ] Monitor \cache_read_input_tokens\ in logs to verify cache hits
- [ ] Update agent documentation to reference the skill

## References

- [Claude caching documentation](https://docs.anthropic.com/en/docs/build-a-bot/manage-context#token-caching)
- [OpenAI cache usage documentation](https://platform.openai.com/docs/guides/prompt-caching)
- [Ollama documentation](https://github.com/ollama/ollama)
\\\

### Step C2: Update design.md (optional)

**Location:** End of Phase 1 (after toolchain-detection)

**Add this note:**

`markdown
### 1f — Context Caching (Optional Advanced)

After building \CODEBASE_CONTEXT\ and \RECALLIUM_CONTEXT\:

**Only if your context exceeds 50 KB and you expect 8+ subagent invocations:**

Load the \context-cache-control\ skill:

\\\
skill("context-cache-control")
\\\

This generates provider-specific cache headers for optimal caching. For most tasks (typical 10–30 KB codebase), skip this step — automatic caching (Option A behavior) is sufficient.
`

### Step C3: Document in AGENTS.md

**Location:** In "Context Caching" section (after Option B additions)

**Add subsection:**

`markdown
### Advanced: Provider-Specific Caching (Optional)

For large-scale pipelines (50+ KB context, 8+ agent invocations per run), load the \context-cache-control\ skill to enable provider-specific optimization:

\\\markdown
Load the skill in your agent:
\\\

This is **optional** and only provides measurable benefits at extreme scale. For most tasks, automatic caching (Option A) is sufficient.

Supported providers:
- **Claude:** Explicit \cache_control\ headers (automatic best-effort, explicit headers for max control)
- **OpenAI:** System message auto-caching (automatic)
- **Local Ollama:** Automatic context reuse (automatic)

See \skills/context-cache-control/SKILL.md\ for debugging cache hits and detailed API examples.
`

## Verification

- Create \skills/context-cache-control/SKILL.md\ with content above
- Update \design.md\ Phase 1f (optional)
- Update AGENTS.md with new subsection
- Test with a complex task (50+ KB codebase)
- Verify cache hits via provider logs (\cache_read_input_tokens\, \cache_creation_input_tokens\)
- Benchmark latency before/after enabling

## Expected Outcome

- Provider-specific cache control headers generated automatically
- Cache metrics visible in API responses
- Optimal caching for large codebases (50+ KB)
- Optional feature — does not break if not used
- Enables future provider integrations (new cache APIs, new LLM providers)

## When NOT to Use Option C

- Codebase context < 50 KB (automatic caching is sufficient)
- < 8 subagent invocations per pipeline run (overhead not justified)
- Simple tasks (automatic caching is sufficient)
- Team not monitoring cache metrics

For 95% of use cases, Option A + Option B are sufficient.
