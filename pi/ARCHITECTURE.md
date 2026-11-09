# Pi delivery pipeline: component map

**Status: describes the system after the Scaffold-ledger port (pi/LEDGER_DESIGN.md); the port is in review, so this reflects the `claude/ledger-pi-port` branch, not yet `main`. Derived from reading the code.** Items marked *(unverified)* were
inferred, not traced. [`../workflow-overview.md`](../workflow-overview.md) describes
the *process*; this file describes the *parts*, where state lives, and what guards what.
[`agent/lib/README.md`](agent/lib/README.md) describes library boundaries in more depth.

## 1. What the system is for

Pi (an LLM agent) implements a feature in small tasks, unattended, on a feature branch.
The system exists so that a human can trust the result without watching. It does that by
enforcing one invariant:

> **Every commit between the feature's baseline and HEAD is an authenticated checkpoint
> of one task that passed its checks and an independent review, under a feature direction
> the user approved.**

Almost everything below either *produces* the evidence for that invariant, *checks* it, or
*recovers* when real life breaks it (rebases, interruptions, extra commits).

## 2. Actors

| Actor | What it is | Owns | Trust |
|---|---|---|---|
| **User** | A human | The one direction approval; adoption approval; merging/publishing | Source of authority. Only a real UI confirmation counts. |
| **Pi** | The LLM orchestrator, driven by `SYSTEM.md` and skills | Reasoning, designs, choosing the next task | **Not trusted.** Cannot edit source directly; only native tools apply changes. |
| **Scaffold** | External CLI that owns the per-feature ledger (`.scaffold/features/…`, gitignored) | Feature + issue graph, designs, task status, `original_baseline`, `workflow.instance_id`, delivery journal | Validates structure and association, **not** evidence authenticity. |
| **Conductor** | External generic command runner | Runs a list of commands with conditions | Neutral runner. |
| **Executor** | External CLI | Applies a set of file operations | Makes the edits. |
| **Review** | External independent reviewer (separate model) | Approves or rejects a diff against the requirements | Independent judge. |
| **Linear** | Ticket system | Ticket source | Input only. |

## 3. Stages, skills and tools

```mermaid
flowchart LR
  T[Linear ticket / requirements] --> I[init-feature]
  I --> A{{approve_feature_direction<br/>ONE user approval}}
  A --> D[design + decompose<br/>issue graph in Scaffold]
  D --> L[feature-delivery loop]
  L --> E[implement-task: ONE issue]
  E --> X[execute_and_review<br/>Executor -> checks -> Review]
  X -->|PASSED| C[automatic verified checkpoint<br/>one local commit]
  X -->|BLOCKED / NEEDS_DESIGN| E
  C --> L
  L -->|all tasks done| V[validate_feature<br/>full checks + whole-feature review]
  V --> U[user reviews, publishes, merges]
```

Note the order: direction approval happens **before** the issue graph is designed. The
approved "direction" is the feature-level design context, objective, criteria and
constraints. Issue designs are produced afterwards, inside that approved scope.

| Stage | Skill | Native tool(s) | Code |
|---|---|---|---|
| Prepare feature | `init-feature`, `design` | `scaffold_tasks`, `write_plan`, `linear_*` | `extensions/scaffold`, `extensions/plan`, `extensions/linear` |
| Approve direction | (in `init-feature`) | `approve_feature_direction` | `lib/authorization/feature.mjs` |
| Orchestrate | `feature-delivery` | none of its own | skill text |
| One task | `implement-task`, `executor` | `execute_and_review` | `extensions/execute-and-review` |
| Checkpoint | (automatic) | `checkpoint_verified_task` (recovery only) | `extensions/checkpoint` |
| Final gate | `feature-delivery` | `validate_feature` | `extensions/feature-validation` |
| Standalone review | `review` | `review_changes` | `extensions/review` |

### Every registered tool

| Tool | Extension | Purpose | Mutates |
|---|---|---|---|
| `scaffold_tasks` | scaffold | Scoped read/write of the task graph | Scaffold state |
| `approve_feature_direction` | execute-and-review | The one direction approval | evidence |
| `approve_delivery_amendment` | execute-and-review | Approve a material contract change | evidence + Scaffold |
| `execute_and_review` | execute-and-review | One Executor, checks, Review pass; auto-completes and checkpoints on PASS | source, evidence, Scaffold, Git |
| `checkpoint_verified_task` | checkpoint | Create or recover the checkpoint commit for a passed task | Git |
| `validate_feature` | feature-validation | Final full checks + whole-feature review | evidence, Scaffold |
| `inspect_conductor_evidence`, `inspect_feature_validation`, `inspect_issue_handoff`, `inspect_issue_attempt` | various | Read retained evidence and handoffs | none |
| `suspend_issue`, `resume_issue` | execution-recovery | Park an unfinished issue (saved source/index) and return the graph to design; restore it later | Scaffold, refs, evidence |
| `prepare_issue_handoff` | execution-recovery | Save scoped context for a fresh session | evidence |
| `rewrite_feature_history` | execution-recovery | After a user rebase between tasks: map the recorded history onto the rebased commits, re-verify, record a `history-rewrite` | ledger |
| `adopt_foreign_commits` | execution-recovery | Record user commits that are not task checkpoints (`history-foreign`), between tasks | ledger |
| `inspect_feature_drift` | execution-recovery | Read-only: classify Git drift, name the recovery (PR #87) | none |
| `review_changes` | review | Standalone review | none |
| `write_plan`, `write_ticket_file` | plan | Write planning documents | files |
| `linear_*` (4) | linear | Ticket API | Linear |

Also in the repo but unrelated to delivery: the `lsp` and `conductor` (`/conductor` command)
extensions, and the `comfyui-generate` skill.

## 4. Where state lives

**One ledger per feature instance, owned by Scaffold.** Pi never reads Scaffold's files; it reads and writes
only through the Scaffold CLI. See [`LEDGER_DESIGN.md`](LEDGER_DESIGN.md) for the design and its rationale.

```
.scaffold/                       ignored and untracked; Pi refuses to run if it is visible to Git
  features/<feature>.<instance>/
    ledger.jsonl                 append-only, hash-chained: every action, its payload and its state change
    artifacts/<sha256>           receipts, approvals, verifications, suspensions (content-addressed JSON)
  work/                          scratch: Conductor runs, boundaries, finalization, handoffs (not evidence)
```

| What | Where it lives | Written by |
|---|---|---|
| Feature, issue graph, designs, task status | the ledger (folded state) | Scaffold |
| Direction approval | `direction-approve` entry | Scaffold, after Pi's UI confirmation |
| Task receipts | artifact, cited by an `attempt-record` entry | Pi stores it, Scaffold records the attempt |
| Completion, checkpoints | `complete` and `checkpoint-record` entries | Scaffold, after Pi verifies Git |
| Recorded history from base to head | `history` / `head` / `base` / `epochs` in the folded state | Scaffold (`checkpoint-record`, `history-foreign`, `history-rewrite`) |
| Feature validation results | `validation-*` entries; the full record is an artifact | Scaffold and Pi |
| The checkpoint commits themselves | Git; trailer `Pi-Checkpoint: <task>` | Pi |

Scaffold enforces the rules between these (a completion must cite a recorded PASSED attempt; a checkpoint must
continue from the recorded head; `start` needs a matching approval; validation needs the recorded head). Pi
confirms everything that needs Git, the Executor or the reviewer before appending.

**What is still outside the ledger.** A few Git refs keep saved source reachable so garbage collection cannot lose
it: `refs/pi-issue-suspensions/` (parked source), `refs/pi-task-recoveries/` (before/after trees of a handoff chain),
`refs/pi-checkpoints/` (a checkpoint commit in flight) and `refs/pi-delivery-journals/` (journal audit anchors).
They hold Git objects, not records. Replacing them with ledger artifacts is future work.

**Limits.** The chain makes edits to history detectable; it does not stop a process with write access from
appending a forged entry, and it cannot detect removal of the newest whole entries. The ledger is per checkout.

## 5. Code layers

```
skills/ + SYSTEM.md          guidance for Pi (text; no enforcement)
extensions/*/index.ts        tool registration + user-facing confirmations
extensions/*/*.mjs           workflows: coordinate, perform lifecycle writes
lib/verification             authenticate evidence, chains, checkpoints (pure checks)
lib/authorization            feature/amendment authority
lib/evidence, scaffold, git  ledger artifact client, Scaffold CLI client, Git snapshots, contracts
external: Scaffold, Conductor, Executor, Review
```

Rule (from `lib/README.md`): **`lib` never imports from `extensions`.** Coordinators fetch fresh
Scaffold data and pass it in; libraries validate it.

## 6. Where the invariant is enforced

`checkpointHistory()` (`lib/verification/checkpoint-history.mjs`) walks HEAD back to the
baseline and requires each commit to be an authentic checkpoint matching a completed task
and its receipt. It is called from:

`issue-scope` (before executing a task), `attempt-chain` (continuations), `checkpoint/commit.mjs`
(creating a checkpoint), `feature-validation` (final gate), `lib/verification/reconciliation.mjs`
and `execution-recovery/reconciliation.mjs` (rebase), `issue-recovery`, and `drift.mjs`.

Any new situation in which history legitimately contains something that is not a checkpoint
needs its own accommodation here. That is the source of most special cases.

## 7. Authority

| Grant | Granted by | Lasts | Covers |
|---|---|---|---|
| Feature direction | `approve_feature_direction` (UI confirm) | A `direction-approve` ledger entry; Scaffold computes and matches the scope digest | The whole local loop: design, implementation, checks, review, checkpoints, recovery. **Not** publish or merge. |
| Delivery amendment | `approve_delivery_amendment` | Per change | One concrete contract change |
| Foreign commits | `adopt_foreign_commits` (UI confirm) | Recorded in the ledger | One named recorded head to new head range |
| Checkpoint grant | per-session UI grant (`checkpointAuthorization`) | Session | Local commits; separate from feature direction |

## 8. Recovery: which tool, when

| Situation | Use |
|---|---|
| Not sure | `inspect_feature_drift` |
| Clean user commits between tasks | `adopt_foreign_commits` |
| You rebased between tasks | `rewrite_feature_history` |
| You rebased while a task was active | `suspend_issue`, `rewrite_feature_history`, `resume_issue` |
| A task failed or was interrupted | continue with `previousAttempt` / issue handoff |
| Checkpoint commit lost or interrupted | repeat `checkpoint_verified_task` |
| Need to park an issue and return to design | `suspend_issue`, then `resume_issue` |
| Never | edit the ledger by hand; run `scaffold clean` as a recovery step (it only closes a feature now); reapprove to reset history |

## 9. Glossary

- **Original baseline**: commit the feature branched from; recorded in Scaffold; immutable.
- **Execution baseline**: where checkpoints begin. Equals the original baseline unless adopted.
- **Instance id**: `workflow.instance_id`; distinguishes a recreated feature from the original.
- **Receipt**: content-addressed evidence of one task attempt (checks + review).
- **Checkpoint**: the local commit produced for a passed task, carrying provenance in a trailer.
- **Anchor**: a verified point that lets history checks start later than the baseline (rebase reconciliation).
- **Adoption**: user-approved move of the execution baseline over unverified commits. They stay in review scope.
- **Handoff / suspension**: saved context or source so work can resume in a fresh session or after a design change.
- **Reconciliation**: verification-only recovery after a rebase.

## 10. Known gaps in this map

- Saved source for suspended issues and handoffs is still pinned with the four `refs/pi-*` families (section 4).
- Suspension with *consumed attempts* (dirty source saved and restored) is exercised by the older stub-based tests,
  not yet by a real-Scaffold test; the zero-attempt path is.
- Not traced: the internals of Scaffold's design-phase rules, Conductor, Executor and Review.
