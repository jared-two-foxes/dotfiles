---
name: pipeline-completion-store
description: Use after confirming code has been pushed to store a Recallium completion record. Requires PROJECT_NAME, a completion summary, and a list of modified files to already be in context.
---

# Pipeline Completion Store

Store a Recallium completion record after push is confirmed.

## Standard Call (orchestrators and pipeline agents)

Call `store_memory` with:
- `memory_type`: `feature`
- `project_name`: `PROJECT_NAME`
- `content`: the completion summary (what was built, acceptance criteria met, key decisions)
- `related_files`: all files modified during this session
- `tags`: `["completed-feature"]` — append any additional context tags available (e.g., a Linear issue ID such as `ENG-123`)
- `importance_score`: `0.7`

## Build Agent Variant (when push is uncertain)

If the user did not confirm a successful push but work was completed:
- `memory_type`: `debug`
- `project_name`: `PROJECT_NAME`
- `content`: the completion summary with a note that push status is uncertain
- `related_files`: modified files
- `tags`: `["in-progress"]`
- `importance_score`: `0.5`
