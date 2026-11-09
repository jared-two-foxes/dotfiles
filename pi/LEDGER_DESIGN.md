# Design: one ledger per feature, owned by Scaffold

**Status: proposal for review. No code has been written.**
Describes the target that replaces the stores mapped in [`ARCHITECTURE.md`](ARCHITECTURE.md) section 4.
Spans two repositories: `jared-two-foxes/scaffold` (Python CLI) and this one (`pi/agent`).

## 1. Decisions already made

| Decision | Source |
|---|---|
| Scaffold may be changed freely; evidence references may move out of Scaffold or into it | user |
| Go straight to the largest-payoff design; no intermediate steps | user |
| The ledger is **not committed** to the codebase and **not stored in `.git`**; it lives in an obvious, ignored location | user |
| Breaking existing features is acceptable if the result is simpler | user |
| Location `.scaffold/features/<feature>.<instance>/` | accepted recommendation |
| Tamper-**evident** hash chain; no signing | accepted recommendation |
| No retention refs; the ledger records what was verified; old commits are best-effort | accepted recommendation |

## 2. Problem, restated from the code

Scaffold (`src/ticket_pipeline`, about 1,500 lines) already is a small ledger in disguise:
one `operate()` call is a locked read, validate, mutate, write transaction over a single
`.scaffold/tasks.json`, and that file contains per-task `history`, a per-task append-only
`delivery` journal, a `checkpoint` record, a `suspension` record and a `validation` history.

What Scaffold does **not** hold is the evidence. It stores opaque references
(`pi-evidence:sha256:…`, `pi-feature-evidence:sha256:…`) whose format it checks with a regex.
Pi holds the records those point to (in `.git/pi-conductor-evidence/`), and re-verifies that the
Scaffold history, the receipt, the commit trailer and the Git tree all agree.

So the same facts live in four places, and `checkpointHistory()` and its callers exist to
keep them consistent. The proposal removes the need by making them one record.

## 3. Design

### 3.1 Layout

```
.scaffold/                                   already gitignored; already excluded from snapshots
  .tasks.lock                                existing flock file, kept
  features/
    <feature-id>.<instance-id>/
      ledger.jsonl                           append-only, hash-chained
      artifacts/<sha256>                     content-addressed large blobs
```

* The instance is the directory. A recreated feature gets a new directory, so an old
  approval or receipt **cannot** apply to it. This replaces the instance-id checks that are
  currently repeated in Pi.
* `scaffold clean` stops deleting. It appends a terminal `feature.closed` entry. History stays
  inspectable, and the "current" instance of a feature id is the one with no terminal entry.
* Pi's existing rule that `.scaffold/` must be ignored and untracked is unchanged.
* `tasks.json` is removed. State is a **fold** of the ledger.

### 3.2 Entry format

One JSON object per line:

```json
{"seq": 7, "prev": "<sha256 of entry 6>", "type": "attempt.recorded", "at": "<utc>", "body": { }, "hash": "<sha256 of this entry without hash>"}
```

* `hash` is the SHA-256 of the canonical JSON of the entry without the `hash` field. Genesis `prev` is 64 zeros.
* Writers append under the existing flock with an `expected_seq` compare-and-swap, the same pattern
  Scaffold already uses for `delivery-record`.
* An entry is written as one `write` of `line + "\n"` followed by `fsync`. A trailing line with no
  newline is a torn write and is discarded. A hash mismatch anywhere else fails closed.
* References between entries are entry hashes in the same ledger. A dangling reference is rejected at
  append time, so dangling references cannot exist.
* Large payloads (check output, review verdicts) are written to `artifacts/<sha256>` **before**
  the entry that cites them. An orphaned artifact is harmless. Readers re-hash artifacts on use.

### 3.3 Entry types

Existing Scaffold events map straight across. New types replace Pi-side evidence kinds.

| Entry | Replaces |
|---|---|
| `feature.initialized` {id, instance, title, objective, criteria, constraints, context, design_ref, baseline, branch} | `scaffold init`; the `original_baseline` field |
| `direction.approved` {scope_digest, capabilities} | `feature-authorization` evidence |
| `graph.*` (`issue.added`, `issue.decomposed`, `design.recorded`, `design.finished`, `design.reopened`) | existing graph actions, unchanged in meaning |
| `task.started`, `task.blocked`, `task.failed`, `task.retried` | existing task history events |
| `attempt.begun`, `attempt.recorded`, `attempt.handoff`, `context.revised` | delivery journal events and task receipts |
| `task.completed` {task, attempt} | `complete` plus its evidence reference |
| `checkpoint.recorded` {task, commit, parent, tree, attempt} | `checkpoint-record` plus the commit trailer facts |
| `history.foreign` {from, to, kind, commits, approval} | `baseline-adoption`; also mid-flight user commits |
| `history.rewritten` {old_head, new_head, mapping, verification} | `reconciliation` and rebase handoffs |
| `issue.suspended`, `issue.resumed` | suspension and handoff evidence |
| `amendment.approved` | `delivery-amendment` evidence |
| `validation.started`, `validation.finished`, `validation.invalidated` | existing validation history and feature evidence |
| `feature.closed` | `scaffold clean` |

`history.foreign` and `history.rewritten` are the two ways Git history may legitimately contain
something that is not a task checkpoint. Everything that is currently a special case in
`checkpointHistory()` (adoption, rebase, interrupted rebase, and the not-yet-handled mid-flight and
merge cases) becomes one of these two entries.

### 3.4 What Scaffold enforces

Scaffold's state machine becomes the home of rules now scattered across Pi.

* `start` is refused unless a `direction.approved` entry exists whose `scope_digest` matches the
  current feature definition. This removes `requireFeatureAuthorization` from every Pi call site.
* `complete` requires an `attempt.recorded` entry for that task with result `PASSED`.
* `checkpoint.recorded` requires that task's `task.completed`.
* `validation.finished` (PASSED) requires every task completed and checkpointed.
* Material changes to the feature definition after approval invalidate the approval (it no longer
  matches), as exact-scope matching does today.

### 3.5 What stays in Pi, and the limit of what is verified

Pi still owns everything that needs Git, the Executor or the reviewer:

* Before appending `checkpoint.recorded`, Pi confirms the tree and parent in Git.
* Before appending `history.foreign` or `history.rewritten`, Pi confirms ancestry and mapping, and
  obtains the user's approval through the UI.
* Pi writes attempt records; Scaffold records what Pi submits.

**Honest limit:** the chain makes edits to history detectable. It does not stop a process with
write access to `.scaffold/` from appending a forged entry, and Scaffold cannot inspect the truth of
a review verdict. Approval entries are only as trustworthy as Pi's UI confirmation. Signing would
change this and is deliberately out of scope.

### 3.6 History verification (replaces `checkpointHistory`)

Walk first-parent history from HEAD to the feature baseline. Every commit must be either:

1. the commit of a `checkpoint.recorded` entry whose parent and tree match Git, or
2. inside a range named by a `history.foreign` entry, or
3. a commit that a `history.rewritten` entry maps from a recorded checkpoint.

Anything else is drift, which `inspect_feature_drift` already reports. Every completed task must have a
checkpoint, and checkpoint order must respect task prerequisites, as today.

The commit trailer shrinks to `Pi-Checkpoint: <task>@<entry hash>`. Verification does not depend on it,
but it survives a rebase and lets Pi propose the old-to-new mapping automatically.

Review scope is unchanged: final validation reviews baseline to HEAD, and the requirements list
`history.foreign` ranges as unverified and in scope. Nothing is exempted.

### 3.7 Retention

No `refs/pi-*` namespaces. Rebase records store old and new head SHAs and the mapping. Suspension
stores the saved source as an artifact (a patch or tar), not as a Git ref. Old commits that become
unreachable may be garbage-collected; the ledger still records what was verified.

### 3.8 Concurrency, crash and lost-response behaviour

* One global flock, as today. Appends are serialized.
* Every mutating operation has an idempotency key (attempt id, validation attempt id, entry hash of
  the thing being acknowledged). Replaying the same request returns the existing entry.
* A crash before the append leaves at most an orphaned artifact. A crash mid-write leaves a torn line that
  is discarded. A lost response is recovered by replaying the idempotent request.

## 4. What gets deleted

* In Pi: `lib/evidence/store.mjs` and its two namespaces; every `refs/pi-*` family; `lib/authorization/*`
  (replaced by `direction.approved` and Scaffold's start rule); embedded feature copies in records;
  `requireCurrentFeatureReceipt` and the scattered instance checks; directory-scan lookups; the
  reconciliation, adoption, suspension and amendment record formats; most of `checkpoint-history.mjs`.
* In Scaffold: `tasks.json` and the per-task embedded histories (now a fold); reference-format regexes for
  `pi-evidence:`; the destructive `clean`.
* Documentation: the multi-store explanations in `ARCHITECTURE.md` and `RECOVERY.md`.

PR #87's `adopt_feature_baseline` is subsumed. Its eligibility rules and review-scope handling carry over
unchanged; its storage and its special case in `checkpointHistory` do not.

## 5. Compatibility and migration

None. Scaffold moves to `schema_version: 3`. It already rejects other schema versions without modifying
the file, so an old `tasks.json` is left untouched and unread. Features in flight must be finished,
abandoned, or re-initialized under the new system. This includes the interrupted-conductor-recovery
feature. The cost is accepted by the user.

## 6. Work plan (one coherent change, two repositories)

1. **Scaffold:** ledger writer and reader, fold, schema v3, the state-machine rules in 3.4, CLI changes,
   `clean` as `feature.closed`, tests (chain integrity, torn writes, concurrency, idempotency, every rule).
2. **Pi, storage layer:** an adapter over the Scaffold CLI for ledger reads and appends; delete the evidence
   store and refs.
3. **Pi, verification:** ledger-based history verification (3.6), `checkpoint_verified_task`,
   `execute_and_review`, `validate_feature` ported; tools for `history.foreign` and `history.rewritten`
   replace `adopt_feature_baseline` and `reconcile_feature_rebase`; the interrupted-task rebase flow becomes
   a combination of the two.
4. **Docs and CI:** update `ARCHITECTURE.md`, `RECOVERY.md`, skills and `SYSTEM.md`.

**Sequencing risk:** this repository's CI checks out the latest Scaffold `main`. Pi's pull request cannot pass
until Scaffold's has merged, and the two must be released together. Land Scaffold first, then Pi.

**Testing risk:** dozens of Pi tests (78 in my local run) are skipped unless real Scaffold is present. The new design depends on
Scaffold more, so new integration tests must run against real Scaffold in CI.

## 7. Alternatives considered

| Alternative | Why not |
|---|---|
| Ledger as a chain of Git commits | You rejected committing it, and `.git` storage; also adds nothing for a per-clone ledger |
| Keep the evidence directory, add an index and a retention helper | Fixes scans and retention only; leaves the copies that must agree |
| Signed approvals | More machinery; the threat model does not call for it yet |
| Keep Scaffold as state only, ledger in Pi | Two owners of one history, which is the current problem |

## 8. Open points

* Ledger growth and fold cost: JSONL is linear and fine at this scale. A snapshot cache can be added
  without changing the format.
* Moving a feature to another machine is not supported; a later `scaffold export` could bundle a ledger.
* `.scaffold/` is per worktree. Pi's temporary verification worktrees must not read or write it.
* I have not read Scaffold's issue-workflow rules (`issue_workflow.py`) line by line. This design leaves
  the design-phase graph rules unchanged and swaps only storage.
* The exact entry bodies need a schema pass before implementation; section 3.3 fixes names and intent, not fields.
