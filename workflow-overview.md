# Current Pi workflow

Pi remains the sole reasoning-based orchestrator. [Design](pi/agent/skills/design/SKILL.md)
owns discovery and decisions; [Scaffold](pi/agent/skills/scaffold/SKILL.md) persists
state; [Conductor](pi/agent/skills/conductor/SKILL.md) performs one bounded exact
Executor attempt and independent Review. No new coordinator or storage schema is
needed for architectural approval followed by local detailed design.

1. Discover the repository and collaboratively resolve feature-wide objectives,
   acceptance criteria, ownership, shared interfaces/semantics, invariants,
   persistence, security/compatibility constraints and integration risks. Agree
   feature verification expectations and approve this high-level architecture.
   Defer task-local algorithms and implementation details.
2. Decompose the approved architecture into independently understandable,
   designable, implementable and verifiable behaviors. Confirm consequential
   boundaries and dependencies; do not split by files or line counts.
3. Persist the exact architecture, approval record, original feature Git baseline
   and branch in feature `context` via `scaffold_tasks`. `design_ref: "sha256:context"`
   becomes the immutable digest. Add tasks with stable IDs, objectives, criteria,
   relevant context including `Verification:`, inherited constraints and explicit
   dependencies. A complete internal design is not required to persist a task.
4. Inspect full state and select one ready task with `next`. Inspect its source,
   dependencies, completed interfaces and relevant architecture. Discuss detailed
   structures/usage, algorithms, contracts, errors and tests for this task only.
   Obtain task design approval on a concise code-led preview. Settled architecture
   needs no repeat approval; new consequential local decisions do.
5. Prepare exact operations only for this approved task. Obtain separate execution
   approval, start the task and invoke `execute_and_review`. Its fixed requirements
   include task criteria, applicable architecture, approved task decisions and the
   actual task design approval record. Retained receipts preserve this request.
6. Inspect meaningful checks, independent APPROVED review and authentic evidence
   through `inspect_conductor_evidence`, then complete the exact task in Scaffold.
   Preserve correction limits: five attempts and stop after two repeated failures
   without progress. Reconcile partial changes; never replay operations blindly.
7. End the loop and obtain separate `checkpoint_verified_task` authorization.
   Inspect the exact checkpoint before selecting and designing the next task.
   Each task reviews from the preceding checkpoint; the original feature baseline
   remains fixed for cumulative validation.
8. After every child and recursive parent is verified and checkpointed, obtain
   `validate_feature` authorization. Validate cumulative changes against the original
   approved architecture and feature criteria. Task design evidence supplements
   that specification; no enormous feature-wide detailed design is required.

A small change that fits one bounded reasoning and verification scope keeps the
streamlined detailed design approval → operations → execution approval flow. It
needs no artificial decomposition or extra architecture approval round.

If task design is too complex, use `decompose` before implementation; no failed
attempt is needed. Children inherit relevant constraints/context and dependency
ordering. Preserve parent criteria/history and completed work. Children finishing
never completes the parent: it still needs its own integrated verification.

If task design conflicts with shared architecture, stop for feature-level design
and explicit approval. Never silently change immutable references, original criteria
or peer tasks. Additive tasks may satisfy the unchanged original specification.
A contradictory architecture revision cannot be rebound to existing receipts and
checkpoints through current interfaces; block affected work and propose a separately
reviewable reconciliation mechanism. This PR does not introduce design versioning.

On resume recover architecture, decomposition and task history from Scaffold,
then inspect actual Git state, checkpoints and content-addressed receipts under
`git rev-parse --git-path pi-conductor-evidence`. Recover selected/interrupted task
identity from state and receipts, not conversation history or `next` alone.
Task definitions stay immutable: later detailed designs live in the first attempt's
fixed requirements, including its STARTED intent. A STARTED intent proves no
execution success. Receipts retain recorded approval text but do not authenticate
user consent. Missing task design approval requires reinspection and reapproval;
first reconcile successful implementation without replaying it. There is no
standalone design-note write before the first attempt, so an interruption in that
window may require repeating the task design approval. Receipts stay local to the
checkout; Git push/clone does not transfer them. Checkpoint grants expire across
sessions; execution, checkpoint and feature-validation authorizations stay separate.

Tests: `node --test tests/pi-*.test.mjs`. Set `SCAFFOLD_SOURCE` to a current Scaffold
checkout to run real lifecycle integration. Deterministic policy tests check the
design sequence; scripted adapter/CLI fixtures check persistence, evidence and
recovery. They do not prove live-model compliance and require no model calls.

---

> **Historical workflow — retired.** The Scaffold execution commands described
> below are no longer supported and must not be invoked. Current Pi implementation
> uses [Design](pi/agent/skills/design/SKILL.md) and approved `execute_and_review`
> calls. [Scaffold](pi/agent/skills/scaffold/SKILL.md) now persists explicit task
> lifecycle state through `scaffold_tasks`; it does not execute implementations.

# Ticket Pipeline Workflow: Entry to Completion

This document walks through the full lifecycle of a Linear ticket
through this repo's automation, in the order it actually runs, end to
end. Each step is tagged with how it's done:

- **[AI]** - an LLM call actually makes a judgment or produces content
  (a plan, a test, an implementation, a verdict).
- **[Mechanical]** - pure code: a subprocess (build/test/lint/git), a
  regex/string check, a file read/write. No model involved, fully
  deterministic given the same inputs.
- **[Human]** - the pipeline stops and waits for a person to act (write
  code, answer a question, approve/re-run).

Several steps are hybrids (a mechanical pre-check that only escalates
to AI in an ambiguous case, or an AI step wrapped in a mechanical
gate) - those are called out explicitly rather than forced into one
bucket.

---

## The shape of the whole thing

```
scaffold prep-ticket     (AI, loop)         "is this ticket's wording accurate?"
      |
scaffold explore-ticket  (AI, interactive)  "is this ticket's scope complete?"
      |
scaffold push-ticket     (mixed)            "seed the work queue"
      |
      v
  +--------------------------------------------+
  |   scaffold next-step   (run repeatedly)    |
  |   - write a test, implement, or re-check   |
  |   - pause only for genuine human-only      |
  |     confirmation/inspection                |
  |   - detect green, pop, repeat              |
  +--------------------------------------------+
      |
      v  (once every criterion for the ticket is popped)
TICKET_VALIDATE      (mixed)            "does the whole ticket hold up?"
      |
   APPROVED -> done          CHANGES REQUESTED -> new frames -> back into scaffold next-step
```

Only one file survives across every invocation of every script below:
`.criteria-stack.json`. Everything else (`.ticket.md`, `.tdd-plan.md`,
`.gap-plan.md`) is regenerated scratch, safe to blow away and rebuild.

---

## Stage 0 - `scaffold prep-ticket <id>` (entry point)

**Purpose:** catch a ticket whose wording is stale, wrong, or already
satisfied by existing code, before anyone plans or implements against
it.

| Step | Nature | What happens |
|---|---|---|
| `scaffold review-ticket` | **[AI]**, read-only | Fetches the ticket from Linear, checks its claims against the actual codebase (does the thing it says is missing actually exist already? does it reference something that changed?). Verdict: `clear` or flagged concerns. |
| `scaffold propose-ticket-edit` | **[AI]** | If not clear, rewrites the ticket text to resolve the reviewer's concerns. Can also conclude "no remaining work" if every criterion turns out already satisfied. |
| loop control | **[Mechanical]** | `scaffold prep-ticket` re-runs review against the proposed edit, up to `--max-iterations`, until a `clear` verdict or a "no remaining work" result. |

**Never touches Linear or `.ticket.md`** - output is a local working
file (`.ticket-proposed-{id}.md`), fed forward by hand.

**Exit conditions:** clean review (continue to explore-ticket), or
"already satisfied" (stop - consider closing the ticket instead).

---

## Stage 1 - `scaffold explore-ticket <id>` (interactive)

**Purpose:** the one step in this whole pipeline where a human is
actually expected to be present and typing. Turns a vague ticket into
one with a complete, precise set of acceptance criteria.

| Step | Nature | What happens |
|---|---|---|
| explore/grill loop | **[AI]** + **[Human]** | The model reads the codebase, then asks one concrete question at a time (`ask_user_question`), reads your real answer, and keeps exploring/asking until it judges the criteria complete enough to implement without further back-and-forth. |

Output is a proposed, expanded ticket - never written to Linear unless
you choose to push it there yourself. This deliberately runs **after**
review (wording is trustworthy first) and **before** the complexity/split
check in `scaffold push-ticket` (so a ticket that only grows more precise here,
not more numerous, doesn't falsely trip a "needs splitting" signal).

---

## Stage 2 - `scaffold push-ticket <id>` (seed the work queue)

**Purpose:** turn one ticket into a stack of `CriterionFrame` entries -
one per acceptance criterion still not satisfied by the codebase - or,
if the ticket is too broad, into real Linear sub-issues instead.

Runs once per ticket (and once per child, if it splits), in this order:

| Step | Nature | What happens |
|---|---|---|
| Fetch | **[Mechanical]** | Pulls the ticket text from Linear via GraphQL. |
| Complexity check | **[Mechanical]** pre-check, escalates to **[AI]** only if ambiguous | Counts acceptance criteria and checks for conjunction phrases ("and", "as well as") mechanically first. Clearly simple -> skip AI entirely. Clearly complex, or ambiguous -> an AI pass (`split-ticket` prompt) judges whether/how to split, using cohesion (do these criteria share the same code) as its test, not just count. |
| Split (if triggered) | **[Mechanical]** | If a split is recommended, real Linear sub-issues are created (`scaffold create-child-tickets`, a GraphQL mutation) - `--dry-run` previews without creating anything. The parent gets a "validating" sentinel (nothing left for it to implement directly); each child recurses through this exact same fetch -> split-check -> plan+narrow sequence. |
| Plan | **[AI]** | Generates a full TDD plan (`.tdd-plan.md`) from the ticket - acceptance criteria plus an implementation-plan sketch. |
| Narrow | **[AI]** | Re-reads the actual current codebase and narrows the plan down to only the criteria **not yet satisfied** (`.gap-plan.md`). Also classifies each retained criterion: `verify: test` (a red/green test can hold it) or `verify: manual` (docs/config/CI - no meaningful test), and, if a criterion is really about changing behavior an *existing* test already asserts, tags exactly which test (`existing_test: file::name`) instead of leaving it to be discovered later. |
| Seed the stack | **[Mechanical]** | One `CriterionFrame` per remaining criterion, written to `.criteria-stack.json` in one atomic write (including every recursively-split child's frames, correctly ordered). |

**Guards (all mechanical, run before anything is touched):** re-entrancy
check (this ticket already on the stack), clobber check (a *different*
ticket is mid-flight - resolved via `--force` to abandon it or
`--prepend` to insert ahead of it as a prerequisite).

---

## Stage 3 - `scaffold next-step` (run repeatedly until no work remains)

The main loop. Every invocation looks at the top of the stack, re-checks
real state (never trusts the stored `status` blindly), and advances
exactly one phase. `--continuous` chains every automatable transition
without stopping; it still always pauses at a genuine human decision
point.

### 3a. Write the test (`WRITE_TEST` phase)

| Step | Nature | What happens |
|---|---|---|
| Write or modify a test | **[AI]** | If the criterion's `existing_test:` tag points at a specific test, the Tester **modifies only the named assertion(s)** in that existing test. Otherwise it writes a brand-new test, naming it after the subject under test, not the criterion. |
| Compile gate | **[Mechanical]**, with bounded AI retry | Compiles the test suite. On failure, feeds the compile error back to the same AI step for a fix - up to N attempts total, not N *additional* attempts. |
| Test-quality review | **[AI]**, always **advisory, never blocking** | An independent pass reads the test just written/modified and judges whether it's meaningful (not tautological, not testing something adjacent) - and, specifically for a modified test, whether the diff shows any *other* assertion in that test got weakened or dropped. Logs a flagged concern and prints it immediately if found; **never gates anything** - even an AI failure here silently degrades to "no concern" rather than stopping the pipeline. |
| Red check | **[Mechanical]** | Runs just this one test. |

**Outcome branches** (still within `WRITE_TEST`):
- Red, as expected -> continue into implementation automatically
  (**[AI]**, unless `--skip-implementation` is passed to require manual
  implementation).
- Green immediately, and this criterion came from the ticket's own
  original criteria -> trusted as a side-effect of a sibling
  criterion, mark done, continue (**[Mechanical]**).
- Green immediately, but this criterion exists *because* an earlier
  check already judged it unsatisfied (a validate-missed or review
  finding) -> **not** trusted (much more likely a weak test than a
  vanished gap) - pauses: **[Human]** must inspect and either fix the
  test or explicitly confirm with `--accept-green`.

Optional intentional manual-test path (for pending test criteria): write
or edit the test by hand, then run `scaffold next-step --manual-test
--manual-test-ref <file>::<qualified_test_name>` to run the same compile
and scoped red/green gates without invoking the Tester AI.

Optional non-TDD path (for pending test criteria): run
`scaffold next-step --skip-test` to bypass test generation and hand the
criterion directly to the Implementor (build-gated, no red/green loop).

### 3b. Manual criteria (no test at all)

| Step | Nature | What happens |
|---|---|---|
| Mechanical floor check | **[Mechanical]** | For a `verification: manual` criterion (docs/config/CI), there's no test to re-run. Instead: does the file this criterion names (parsed from its own wording) actually show up as changed in `git diff`/untracked files? |
| Dispatch | **[Mechanical]** / **[Human]** | Match found -> trusted immediately, mark done. No match -> pause for a human to make the change, or re-run `scaffold next-step` to let the pipeline attempt it automatically; `--accept-manual` overrides when no specific file could even be identified. |

### 3c. Pop and continue

| Step | Nature | What happens |
|---|---|---|
| Pop | **[Mechanical]** | Once a frame is confirmed done, it's removed from the stack. |
| Ticket-boundary detection | **[Mechanical]** | If the new top frame belongs to a different ticket, or the stack is empty, every frame for the ticket that just finished has been popped -> proceed to Stage 5 (`TICKET_VALIDATE`). |

---

## Stage 4 - `scaffold next-step` implementation phase (optional AI implementation)

Never required - a human can always implement by hand and let
`scaffold next-step` detect green. When `next-step` reaches an
implementation-capable state, a later `next-step` invocation re-checks
every precondition itself before spending anything, and never touches
the stack except through `next-step`'s own status transitions.

### 4a. Level 1 - test-targeted implementation (the common case)

Runs when the top frame has a named failing test (`verification: test`).

| Step | Nature | What happens |
|---|---|---|
| Pre-check | **[Mechanical]** | Re-runs the named test; if it's already green, nothing to do, exit. |
| Implement | **[AI]** | Given the criterion, its plan context, and the failing test's exact name, writes/edits production code to make it pass - never touching the test itself. |
| Build gate | **[Mechanical]** | On failure, error fed back to the AI for another attempt. |
| Green check | **[Mechanical]** | Re-runs the named test. On failure, output fed back for another attempt. |
| Tamper guard | **[Mechanical]** | After *every* attempt, the named test's exact source is byte-compared against a snapshot taken before attempt 1 - any change (even accidental, via an inline test module) hard-fails the run. |

All of the above (write, gate, green-check) shares one bounded attempt
budget - a fix attempt is not a bonus retry on top.

### 4b. Level 2 - direct implementation (no test exists)

Runs when the top frame is `verification: manual` (documentation,
config, CI - anything `narrow` judged as having no meaningful red/green).

| Step | Nature | What happens |
|---|---|---|
| Implement | **[AI]** | Makes the change the criterion describes directly - no test to target, so no tamper guard and no green-check either (there's nothing to protect or re-check). |
| Build gate | **[Mechanical]** | Same bounded retry shape as Level 1, but that's the *only* gate - there is no test-specific check here at all. |

Whether the criterion is actually satisfied is still entirely
`scaffold next-step`'s job (Stage 3b's mechanical floor check) -
the implementation phase never makes that call itself.

---

## Stage 5 - `TICKET_VALIDATE` (runs once, after every criterion for a ticket is popped)

**Purpose:** a whole-ticket safety net - a per-criterion test passing
doesn't guarantee the *ticket* as a whole still holds together.

Pushes a durable "validating" sentinel frame first (**[Mechanical]**),
so a crash partway through resumes validation on the next
`scaffold next-step` call instead of silently skipping it.

| Step | Nature | What happens |
|---|---|---|
| Re-fetch + re-narrow | **[AI]** | Fresh fetch and a fresh narrow pass, as a safety net for anything the per-criterion gates missed. Any criteria still remaining get pushed as new frames (back to Stage 3), not treated as a validation failure. |
| Lint | **[Mechanical]** | Auto-fix, then a hard check; fails the run if unresolved. |
| Full test suite | **[Mechanical]** | Not just the scoped tests touched so far - the whole suite. |
| Smoke test | **[Mechanical]**, optional | Only if a `smoke_cmd` is configured for the project; skipped cleanly otherwise. |
| Code review | **[AI]** | Reviews every file changed since this ticket started against the ticket's original full scope. Verdict: `APPROVED` or `CHANGES REQUESTED`. |

**Outcome:**
- `APPROVED` -> sentinel removed, ticket fully done. **[Mechanical]**
- `CHANGES REQUESTED` -> findings parsed into new criterion frames and
  pushed (**[Mechanical]** parsing of **[AI]**-produced findings) - back
  into Stage 3, no separate command needed.

---

## Quick reference: every AI call in the pipeline

| Script / phase | Prompt | Purpose |
|---|---|---|
| `review-ticket` | review-ticket | Check ticket claims against the codebase |
| `propose-ticket-edit` | propose-ticket-edit | Rewrite ticket to resolve review concerns |
| `explore-ticket` | explore-ticket | Interactive context-gathering with a human |
| `split-ticket` (ambiguous case only) | split-ticket | Judge whether/how to split an overly broad ticket |
| `push-ticket` plan step | plan | Generate the full TDD plan from a ticket |
| `push-ticket` narrow step | narrow-plan | Narrow to unsatisfied criteria; tag `verify:`/`existing_test:` |
| `next-step` WRITE_TEST | test-criterion | Write a new failing test, or modify a named existing one (unless `--manual-test` is used) |
| `next-step` WRITE_TEST (advisory) | review-test-quality | Judge whether the test just (written/modified) is meaningful - never blocks |
| `next-step` implementation phase | implement-criterion | Make a named failing test pass |
| `next-step` implementation phase (manual) | implement-criterion-direct | Directly implement a no-test (manual) criterion |
| `next-step` TICKET_VALIDATE | narrow-plan (again) | Safety-net re-check for missed criteria |
| `next-step` TICKET_VALIDATE | review-singlepass | Whole-ticket code review, APPROVED/CHANGES REQUESTED |

All of the above run as `scaffold <script>` (e.g. `scaffold push-ticket`,
`scaffold next-step`) - see `scaffold --help` for the full command list.

Everything else - fetching from Linear, creating sub-issues, compiling,
running tests, linting, git diffs, snapshot/tamper comparisons, stack
read/write - is deterministic code with no model in the loop.

## Quick reference: every human pause point

| Pause | Trigger | Resolved by |
|---|---|---|
| `scaffold explore-ticket`'s questions | Always, by design | Answering at the terminal |
| `AWAIT_IMPL` | A test is red and `--skip-implementation` is used | Implementing by hand, then `scaffold next-step` |
| `GREEN_UNCONFIRMED` | A fresh test for a validate-missed/review criterion passed immediately | Inspecting the test, or `scaffold next-step --accept-green` |
| `MANUAL_CRITERION` pause | A manual criterion's named file hasn't changed | Making the change, or `scaffold next-step --accept-manual` |
| Stack clobber | Pushing a ticket while a different one is mid-flight | `--force` or `--prepend` |


## Pi task checkpoints (Phase 4)

Pi remains the sole reasoning orchestrator. For each task: separate execution
approval → one bounded Conductor attempt/corrections → inspect actual PASSED
receipt → Scaffold complete → end correction loop → authorized native
`checkpoint_verified_task` → inspect successful checkpoint → select next task.
No background task runner, Conductor commit behavior, automatic publishing or
feature validation is introduced.

Keep feature baseline A in approved feature context. Task 1 reviews A→working
and checkpoints B. Task 2 reviews B→working and checkpoints C. Its review excludes
Task 1's implementation, while the complete feature remains reviewable A→C.
The native tool binds each commit's exact Git tree, parent, feature/task/design,
receipt and original feature baseline in `Pi-Task-Checkpoint` metadata.

Checkpoint permission is manual per call or explicitly feature-scoped via Pi's
confirmation UI for this session. It is separate from design, task execution and
publishing permission. It never permits protected branches, push, merge or
history rewriting. No UI or unknown protection policy means stop.

Git snapshots/staging use private indexes. Only the verified tree is committed;
Scaffold bookkeeping must already be ignored and untracked. No ignore/config
changes are implicit. A branch update and pending ref are atomic; index
finalization is recoverable using that ref and the exact parent/tree/provenance.
Finalization removes the pending ref. Existing locks and unrelated changes block;
source and staged changes are never reset or discarded. See the Design skill for
interruption cases and receipt retention. Local Git hashes do not authenticate
malicious local rewrites. Task-bound Pi calls wrap the approved test command,
forwarding its output/status and capturing Git state after successful tests,
immediately before review. Boundary/final source or index drift blocks success
and checkpoints. Non-task callers are unchanged. Transient concurrent source
writers restored between fingerprints remain unsupported.

Run `node --test tests/*.test.mjs`. Checkpoint tests use temporary Git repositories
and deterministic Conductor/Scaffold CLI fixtures, with no live model calls;
CI runs them on Linux and Windows. The existing correction-limit tests remain.

## End-to-end feature completion

Pi: approved design → persisted atomic tasks → individually approved Conductor
attempts → Scaffold task completion → authorized verified task checkpoints →
native `validate_feature` → full-project checks → independent Review of original
baseline through final HEAD → retained evidence → Scaffold verified revision.

All tasks completed means awaiting final validation. Failed integration returns
findings to Pi for explicit approved corrective tasks and new checkpoints; rerun
validation from the original feature baseline. Interrupted or stale results never
prove completion. Inspect native evidence applicability on resume, and reconcile
authentic complete receipts idempotently before announcing success. The gate
never modifies source, commits or publishes. See Pi Design for the full contract.
