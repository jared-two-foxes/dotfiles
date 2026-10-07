---
name: recallium
description: Use when an agent needs to load persistent memory from Recallium before planning (search_memories), or store a memory after completing work (store_memory). Covers the read protocol, the write trigger table, and the session-recap pattern used by the summarizer.
---

# Recallium Skill

Recallium is the persistent memory MCP server (`http://localhost:8001/mcp`). If the server is unavailable, skip all steps silently — never block or error.

## Read Protocol (before planning)

1. Call `search_memories` with the current repo name and 2–3 keywords from the task. Store results as `RECALLIUM_CONTEXT`.
2. Scan `RECALLIUM_CONTEXT` for:
   - **Failures / rejected approaches** — do not re-propose anything already tried and failed; if you must revisit, explain explicitly why this attempt differs.
   - **Architecture decisions** — do not contradict established decisions without explicit justification.
   - **API facts** — use confirmed endpoint details directly; do not speculate about paths or schemas already stored.
   - **Rules** — treat repo-wide conventions stored in memory as hard constraints.
3. Report to the user: a one-line summary of what (if anything) was found in memory.

## Write Triggers

Call `store_memory` immediately when any of the following occur — do not wait until end of session:

| Trigger | `type` | Required content |
|---|---|---|
| A non-obvious architectural decision is made | `decision` | The decision, rationale, and alternatives considered |
| An API endpoint or schema detail is confirmed | `code-snippet` | Exact path, method, request/response body; tag: `api-fact` |
| A reusable pattern is established | `pattern` | Files that demonstrate it, when to apply it |
| An approach is tried and rejected | `failure` | What was tried, exact error or reason it was rejected |
| A backlog task or feature is completed | `completed-feature` | AC met, files changed, any caveats |
| A repo-wide convention is established | `rule` | When the rule applies and why |

**Required fields on every `store_memory` call:**
- `project`: `PROJECT_NAME` (derived from git remote or workspace folder, normalized to lowercase kebab-case — e.g. `my-app`); add tag `global` if the pattern applies across repos
- Include the file path(s) most relevant to the memory
- Include enough rationale that a future session can act without re-reading this conversation

**Do not store:**
- Trivial implementation details obvious from reading the code
- Information already captured in `AGENTS.md` or the backlog

## Session-Recap Pattern (summarizer)

At the end of a session, call `store_memory` with:

- `type`: `session-recap`
- `project`: `PROJECT_NAME` (derived from git remote or workspace folder — passed by the orchestrator)
- `tags`: `[repo-name]`, `session-recap`
- `content`: a concise summary covering:
  - What was completed this session (features shipped, AC met)
  - What was attempted but not finished (if anything)
  - The recommended next step
  - Any key decisions or API facts discovered this session not already stored separately

This ensures the next session can orient itself without re-reading full conversation history.
