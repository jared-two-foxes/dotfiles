---
name: init-feature
description: >
  Prepare an existing Linear ticket or supplied feature requirements in Scaffold:
  capture scope, obtain one direction approval, design/decompose the issue graph,
  and finish Design without implementing source changes.
---

# Initialize a feature

Prepare a persistent Scaffold feature without initiating autonomous implementation.
This skill is independently invocable (for example `/skill:init-feature SA-585`)
or called by `/skill:feature-delivery` before its multi-task implementation loop.
The source can be a Linear ticket or explicit user-supplied requirements.

## 0. Load the source and reconcile existing state

For a Linear identifier, use the existing read-only `linear_get_ticket` tool to fetch
the ticket; do not create, modify or close any Linear issues. Capture its identifier,
URL, title, full description, acceptance criteria and relevant constraints
verbatim in the original feature context. Preserve the ticket as source material:
do not invent criteria, silently discard constraints or treat Linear status as
authorization to modify code. Derive a concise engineering objective and
testable acceptance criteria; explicitly report important ambiguity before approval.

Inspect the current Git repository root, full baseline commit, feature branch,
working-tree/index status and repository-specific instructions. Verify the Linear
ticket belongs to this repository; do not infer a repository from its identifier.
Use a stable feature ID from the ticket identifier (for example `SA-585`) unless
an existing mapping is already established. Store the source reference in the
immutable feature context and use `origin: {kind:"ticket", reference:"SA-585"}`
on any additional ticket-derived issues; the Scaffold root is created automatically
by `init`. Preserve the original baseline/branch binding.

**Before creating anything**, query `scaffold_tasks summary` (and scoped `issue`
when applicable) for that feature ID. If it already exists, verify the source
identifier, original approved direction, design reference, repository, baseline,
branch, status and any current attempt/checkpoint receipts. Reuse the existing
feature and resume only its unfinished design phase when compatible. Never call
`init` again to overwrite, rebase, or conceal a mismatch. If the ticket changed
after the immutable design context was captured, report the delta and use the
explicit feature-amendment/design recovery procedure where permitted; do not
silently mutate original criteria or treat a new Linear revision as an approval.
Do not start a replacement feature or reset attempt history on errors.

## 1. Discover and approve the source requirements

Inspect the actual repository, existing source, relevant tests, interfaces, Git
branch/status and local instructions. Establish the ticket objective, acceptance
criteria, boundaries, important interfaces, constraints and proposed approach.
Discuss unresolved choices that affect the user's objectives, public behaviour,
compatibility, cost or scope. Do not design every private detail up front.

### Feature planning and the single approval

Present a concise overall design direction and the intended local delivery scope:
design/decomposition, implementation, relevant checks and independent review,
verified local commits, final feature validation, and necessary issue/rebase recovery.
Persist its exact text in feature context using `scaffold_tasks` `init`, immutable
`design_ref: "sha256:context"`, original full Git baseline and feature branch.
Scaffold creates the root issue. State creation does not grant source authority.

Call native `approve_feature_direction` with featureId. Its UI confirmation is the
single approval: present the direction, then invoke this tool without a separate
conversational yes/no question. On refusal or absent UI, stop before implementation.
The tool retains scope-bound authority; existing matching approval is reused without
prompting, including after a new session. Preserve its returned reference.
Do not invent authority from a design note, transcript summary or issue status.

An existing feature may use this tool to approve its retained overall direction
once. Prior per-issue approvals alone do not imply this broader delivery grant.

## 2. Design the issue graph downward

Conversational memory is not authoritative; authenticate persisted state and evidence.
Use `summary`, then `design-select` for
one eligible issue. Inspect only that issue's scoped context, ancestor contracts,
inherited dependencies and relevant source. Make detailed engineering decisions
within the approved direction yourself. Share concise progress when useful;
do not turn design previews into additional approval requests.

### One bounded design pass

Use `/skill:design` to produce the issue's bounded engineering contract; persist
that contract using the existing `design-record` operation. The design skill
itself must not initialize Scaffold, authorize implementation or invoke execution.


Define inputs, outputs, immediate responsibilities, interfaces, invariants,
producers/consumers, ownership/lifecycle, failure behaviour and verification.
Use focused `diff` blocks with changed portions marked when explaining decisions;
these are illustrative design excerpts, not executor input. Keep the implementation
preview proportional to the issue and cover acceptance criteria and edge cases.

Mandatory decomposition applies when the issue cannot be understood, implemented
and independently verified in one bounded scope. Add immediate children with
`decompose`; defer their internal details to their own design passes. Preserve
ancestor dependencies and completed descendants. Every child needs a stable ID,
objective, criteria, context, constraints and explicit dependencies. Put
`Verification:` strategy and edge cases in context; retain review/discovery origin.
Definitions remain immutable. Small changes use the root itself as the leaf.

Persist each agent-authored design with `design-record`:
`{summary, verification, approval, disposition: "leaf"|"decomposed"}`.
The existing `approval` field records delegated authority, for example:
"Agent-designed under overall feature direction authorization <actual reference>;
no separate user approval was requested for this issue."
Never claim the user approved an individual issue if they did not. Add a parent's
immediate children before recording its design. Reopened designs retain their
history and invalidate affected unfinished designs, which Pi redesigns autonomously.

Continue downward until every issue has a complete design, then `design-finish`.
No implementation may run before this entire graph design phase completes.
Scaffold validates structure and association, not authority or verification truth.


## 3. Stop at the prepared-feature boundary

On successful `design-finish`, read `scaffold_tasks summary` and verify the
persisted graph is in Implement phase, every required issue has a recorded
design, and the original feature approval is retained and applicable. Return
the feature ID, Linear source, branch/baseline, approved direction reference,
issue counts and any unresolved blockers. A single root leaf is valid for a
small ticket. This skill **never** calls `implement-task`, `execute_and_review`,
`validate_feature`, starts an issue, edits application source or creates a
checkpoint. If approval is declined, design remains incomplete, or state
authentication is inconclusive, stop and report the exact phase/blocker.

Approval is explicitly scoped to the described feature direction and possible
subsequent local implementation/checks/review/checkpoints. Initializing a feature
does not itself grant publishing permission or initiate implementation. Retain
the existing one-direction-approval semantics across sessions; do not ask the
user to approve individual issue designs.
