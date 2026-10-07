# Option B: Moderate — Metadata Config

**Effort:** 45 minutes | **Impact:** Documentation, future-proof | **Risk:** None

## Overview

Formalizes context caching intent in configuration and documentation. Builds on Option A to add discovery, metadata, and future-proofing for provider-specific integrations.

## Implementation Steps

### Step B1: Add context_caching section to opencode.json

**Location:** Top level of JSON (after small_model or before gent)

Add this block to the root JSON object:

`json
"context_caching": {
  "enabled": true,
  "description": "Stable context blocks are passed verbatim across agent invocations to enable LLM API caching (~90% token reduction)",
  "stable_blocks": [
    "CODEBASE_CONTEXT",
    "RECALLIUM_CONTEXT",
    "TOOLCHAIN",
    "PROJECT_NAME",
    "GIT_WORKFLOW"
  ],
  "cache_scope": "pipeline_run",
  "cache_lifetime_seconds": 300,
  "estimated_savings": {
    "description": "Estimated token reduction when 4+ phases reuse the same codebase",
    "token_percent_reduction": 85,
    "latency_percent_reduction": 90
  }
},
`

**Full example** (showing placement in context):

`json
{
  "": "https://opencode.ai/config.json",
  "skills": {
    "paths": ["skills"]
  },
  "small_model": "opencode/claude-haiku-4-5",

  "context_caching": {
    "enabled": true,
    "description": "Stable context blocks are passed verbatim across agent invocations to enable LLM API caching (~90% token reduction)",
    "stable_blocks": [
      "CODEBASE_CONTEXT",
      "RECALLIUM_CONTEXT",
      "TOOLCHAIN",
      "PROJECT_NAME",
      "GIT_WORKFLOW"
    ],
    "cache_scope": "pipeline_run",
    "cache_lifetime_seconds": 300,
    "estimated_savings": {
      "description": "Estimated token reduction when 4+ phases reuse the same codebase",
      "token_percent_reduction": 85,
      "latency_percent_reduction": 90
    }
  },

  "agent": {
    ...rest of config...
  }
}
`

### Step B2: Document in AGENTS.md

**Location:** After "Dynamic Context Pruning (DCP)" section

**Add new section:**

`markdown
## Context Caching

OpenCode leverages automatic LLM context caching to reduce token costs and latency when large stable context blocks are reused across multiple agent phases.

### How It Works

When a large block (file tree, code snippets, memory search results) appears in multiple agent invocations within a single pipeline run, the LLM API recognizes it and caches it after the first transmission. Subsequent invocations skip reprocessing and incur ~90% fewer tokens for that block.

### Configuration

Context caching is enabled by default via \opencode.json\:

\\\json
"context_caching": {
  "enabled": true,
  "stable_blocks": ["CODEBASE_CONTEXT", "RECALLIUM_CONTEXT", "TOOLCHAIN", "PROJECT_NAME", "GIT_WORKFLOW"],
  "cache_scope": "pipeline_run"
}
\\\

### Agent Contract

All agents must pass stable context blocks **verbatim** (without summarization or modification) to ensure the LLM API recognizes them as cacheable. See \pipeline-runner.md\ for the invocation structure.

### Monitoring

- **Token usage:** Check API billing logs for ~90% reduction in cached block tokens
- **Latency:** Monitor agent response times; cached blocks process ~90% faster
- **Cache hits:** Some APIs (Claude, GPT-4o) return cache metadata — check logs if available

### Supported Providers

- **Claude:** Automatic context caching in user messages
- **OpenAI (GPT-4o+):** Automatic system message and context caching
- **Ollama:** Automatic context reuse within sequences
- **Others:** Check provider docs; most modern LLMs support context caching

### Disabling

To disable caching (not recommended), edit \opencode.json\:

\\\json
"context_caching": {
  "enabled": false
}
\\\

This will NOT break functionality — agents will work normally, but token costs and latency will be higher for multi-phase runs.

### Future Integrations

Provider-specific cache headers (Claude's \cache_control\, OpenAI's \cache_creation_input_tokens\) can be integrated via the \context-cache-control\ skill (see Option C).
`

## Verification

- Validate JSON syntax: JSON linter or \
pm install -g jsonlint && jsonlint opencode.json\
- Review AGENTS.md for clarity
- Commit changes to git
- New team members can discover caching by reading \opencode.json\ and AGENTS.md

## Expected Outcome

- Configuration formally documents caching strategy
- AGENTS.md provides visibility into how caching works
- Establishes foundation for future provider-specific optimizations (Option C)
- Enables monitoring via documented metrics in config
