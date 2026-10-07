# Option A: Minimal — Context Reuse Directive

**Effort:** 30 minutes | **Impact:** Immediate, all providers | **Risk:** None

## Overview

Add explicit context preservation instructions to pipeline-runner.md so subagents (tester, implementer, refactorer, code-reviewer, validator) never regenerate or paraphrase stable blocks. This enables automatic LLM caching for ~90% token and latency savings.

## Implementation Steps

### Step A1: Add "Context Caching & Reuse" Section to pipeline-runner.md

**Location:** After "Required Inputs" section (around line 41)

`markdown
## Context Caching & Reuse

The following input blocks are **cacheable and stable** throughout the entire pipeline run and must be passed **verbatim** (without modification, summarization, or truncation) to all subagent invocations:

- CODEBASE_CONTEXT — file tree and key source file contents (loaded once, reused across 4+ phases)
- RECALLIUM_CONTEXT — memory search results (immutable during pipeline run)
- TOOLCHAIN — build, test, lint, and format commands (immutable during pipeline run)
- PROJECT_NAME — project identifier (immutable)
- GIT_WORKFLOW — version control workflow (	runk-based or pr-based, immutable)

### Why This Matters

Modern LLM APIs automatically cache large repeated context blocks:
- **First transmission:** Full processing, full token cost
- **Subsequent transmissions:** Cached blocks recognized and skipped, ~90% token savings
- **Latency improvement:** ~90% reduction for cached block reprocessing

### Agent Contract

When invoking subagents (tester, implementer, refactorer, code-reviewer, validator, security-reviewer, reuse-checker):
1. Do not paraphrase or summarize CODEBASE_CONTEXT, RECALLIUM_CONTEXT, or TOOLCHAIN
2. Pass these blocks exactly as received
3. Prepend these stable blocks to every subagent invocation before the task-specific content

**Structure your invocations like this:**

\\\
[STABLE CONTEXT BLOCK]
CODEBASE_CONTEXT: [exact, verbatim]
RECALLIUM_CONTEXT: [exact, verbatim]
TOOLCHAIN: [exact, verbatim]
PROJECT_NAME: [exact]
GIT_WORKFLOW: [exact]

[TASK-SPECIFIC CONTENT]
CURRENT_PHASE: [phase number and name]
TASK_INSTRUCTIONS: [phase-specific work]
[phase-specific input like: failing tests, implementation files, acceptance criteria]
\\\

This structure signals to the LLM API that the top section is cacheable and the bottom section is new work each time.
`

### Step A2: Update Phase 2 (Tester) invocation

**Location:** Around line 122

Change:
`markdown
For complex tickets, invoke the 	ester subagent with:

**Stable context (pass verbatim):**
- CODEBASE_CONTEXT
- TOOLCHAIN
- PROJECT_NAME
- RECALLIUM_CONTEXT

**Task-specific content:**
- Acceptance criteria from PRECOMPUTED_PLAN
- Phase 2 instructions and objectives

See **Context Caching & Reuse** section for invocation structure.
`

### Step A3: Update Phase 3 (Implementer) invocation

**Location:** Around line 141

Change:
`markdown
Invoke implementer with:

**Stable context (pass verbatim):**
- CODEBASE_CONTEXT
- TOOLCHAIN
- PROJECT_NAME
- RECALLIUM_CONTEXT

**Task-specific content:**
- Acceptance criteria from PRECOMPUTED_PLAN
- Failing tests (if Phase 2 ran), with file paths and contents
- Any reuse-checker or validator findings from prior failed attempts
- Phase 3 instructions

See **Context Caching & Reuse** section for invocation structure.
`

### Step A4: Update Phase 4 (Refactorer) invocation

**Location:** Around line 173

Change:
`markdown
Invoke the
efactorer subagent with:

**Stable context (pass verbatim):**
- CODEBASE_CONTEXT
- TOOLCHAIN
- PROJECT_NAME
- RECALLIUM_CONTEXT

**Task-specific content:**
- Implementation files (paths + contents from FILES_MODIFIED)
- Test files written by the tester in Phase 2 (if Phase 2 ran — pass the file paths and contents)
- Acceptance criteria
- Phase 4 instructions

See **Context Caching & Reuse** section for invocation structure.
`

### Step A5: Update Phase 5 (Reuse-Checker & Validator) invocation

**Location:** Around line 196-199

Change:
`markdown
Both receive stable context (pass verbatim):
- CODEBASE_CONTEXT
- TOOLCHAIN
- PROJECT_NAME
- RECALLIUM_CONTEXT

**Reuse-checker receives additionally:**
- Newly written/modified files (paths + contents)

**Validator receives additionally:**
- Full implementation (paths + contents)
- Acceptance criteria
- IMPLEMENTATION_LOGS

See **Context Caching & Reuse** section for invocation structure.
`

### Step A6: Update Phase 6a (Code-Reviewer) invocation

**Location:** Around line 214

Change:
`markdown
Invoke code-reviewer with:

**Stable context (pass verbatim):**
- CODEBASE_CONTEXT
- TOOLCHAIN
- PROJECT_NAME
- RECALLIUM_CONTEXT

**Task-specific content:**
- The validated implementation (paths + contents)
- Acceptance criteria
- Phase 6a instructions

See **Context Caching & Reuse** section for invocation structure.
`

## Verification

- No code changes required
- Commit updated pipeline-runner.md
- Monitor token usage in API logs for ~90% reduction in cached block costs
- No testing needed; feature works automatically across all LLM providers

## Expected Outcome

- ~90% reduction in tokens for cached blocks (CODEBASE_CONTEXT, RECALLIUM_CONTEXT, TOOLCHAIN)
- ~90% latency improvement for cached block processing
- No API changes or provider-specific syntax required
- Works with Claude, OpenAI, Ollama, and any provider that supports context caching
