---
name: linear-state-transitions
description: Use when syncing a Linear issue state after code changes. Covers transitioning from unstarted to started, and from started to completed or in-review, based on GIT_WORKFLOW. Requires LINEAR_ISSUE_ID, LINEAR_WORKFLOW_STATES, issue.state.type, and GIT_WORKFLOW to already be set.
---

# Linear State Transitions

Apply Linear issue state transitions after code changes have been committed and pushed.

## Prerequisites

Before running transitions, confirm:
- `LINEAR_ISSUE_ID` is set.
- `LINEAR_WORKFLOW_STATES` is loaded (from `linear_linear_getWorkflowStates`).
- `issue.state.type` reflects the state at the **start** of this session (before any transitions).
- Code changes have been committed and pushed. **Never advance a Backlog or Todo issue before this is confirmed.**

## Transition Rules

### Step 1 — Move to In Progress

If `issue.state.type` was `unstarted` at the start of the session:
- Find the first state in `LINEAR_WORKFLOW_STATES` where `type = started`.
- Call `linear_linear_updateIssue` to transition to that state.

### Step 2 — Move to Completion or Review

**If `GIT_WORKFLOW = trunk-based`:**
- Find the first state in `LINEAR_WORKFLOW_STATES` where `type = completed`.
- Call `linear_linear_updateIssue` to transition to that state.

**If `GIT_WORKFLOW = pr-based`:**
- Look for a review-type state in `LINEAR_WORKFLOW_STATES` (names such as "In Review", "Review", or similar).
- If a review state exists: transition to it.
- If no review state exists: ask the user whether to move to a `completed`-type state or leave the issue as-is.

### Step 3 — Report

After all transitions, report each state change applied (e.g., `"Advanced ENG-123: Todo → In Progress → In Review"`).

## Interactive Mode (linear-sync agent only)

When operating interactively (talking directly to the user, not running inside an automated pipeline):
1. Display all available workflow states for the team.
2. Suggest the most logical next state based on the rules above.
3. Ask the user whether to apply the suggested state, choose a different state, or leave Linear unchanged.
4. Apply only after explicit user confirmation.
5. Confirm the new state on success.
