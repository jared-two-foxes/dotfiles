# Design: one ledger per feature, owned by Scaffold

**Status: approved. Scaffold half implemented and under review
([scaffold#22](https://github.com/jared-two-foxes/scaffold/pull/22)); Pi port in progress.**
Describes the target that replaces the stores mapped in [`ARCHITECTURE.md`](ARCHITECTURE.md) section 4.
Spans two repositories: `jared-two-foxes/scaffold` (Python CLI) and this one (`pi/agent`).

Section 9 lists where the implementation differs from the first draft of this design.
Where this document and section 9 disagree, section 9 and the Scaffold README are current.

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
{"seq": 7, "prev": "<sha256 of entry 6>", "type": "attempt-record", "at": "<utc>",
 "body": {"task": "T", "payload": { }}, "patch": [ ], "after": "<sha256 of resulting state>",
 "hash": "<sha256 of this entry without hash>"}
```

* `hash` is the SHA-256 of the canonical JSON of the entry without the `hash` field. Genesis `prev` is 64 zeros.
* Writers append under the existing flock with an `expected_seq` compare-and-swap, the same pattern
  Scaffold already uses for `delivery-record`.
* An entry is written as one `write` of `line + "\n"` followed by `fsync`. A trailing line with no
  newline is a torn write and is discarded. A hash mismatch anywhere else fails closed.
* `type` is the Scaffold action name (`start`, `attempt-record`, `history-foreign`, ...). `body` keeps the
  validated payload for audit. `patch` is the exact change to the feature state and `after` is the digest of
  the state it produces. State is rebuilt by applying patches, **not** by replaying rules, so a later rule
  change cannot make an old ledger unreadable. Every read verifies the chain and each `after`.
* References are **artifact digests** (`sha256:<64 hex>`), not entry hashes: an entry cannot cite its own hash
  because the hash is computed after the entry is built. An action that cites a reference is rejected unless the
  artifact is already stored in the same ledger, so dangling references cannot exist.
* Large payloads (receipts, check output, review verdicts, approvals, suspended source) are written to
  `artifacts/<sha256>` **before** the entry that cites them. An orphaned artifact is harmless. Readers re-hash
  artifacts on use. Pi stores one with `artifact-put` and reads it with `artifact-get`.

### 3.3 Entry types (as implemented)

The entry `type` is the action. Existing Scaffold actions are unchanged in meaning.

| Action (entry type) | Replaces / purpose |
|---|---|
| `init` | feature creation; records baseline, branch, design ref, instance id, and starts `head` and `history` |
| `direction-approve` `{scope_digest, capabilities?}` | `feature-authorization` evidence |
| `add`, `decompose`, `design-record`, `design-finish`, `design-reopen` | existing graph and design actions |
| `start`, `block`, `fail`, `retry` | existing task lifecycle events |
| `attempt-record` `{attempt, status, receipt, base, tree}` | task attempt receipts |
| `complete` `{.., reference}` | completion; `reference` must be the receipt of a recorded PASSED attempt of the task |
| `checkpoint-record` `{commit, parent, tree, reference}` | checkpoint bookkeeping; chains from the recorded head |
| `history-foreign` `{from, to, source, commits, approval}` | `baseline-adoption`; also mid-flight user commits |
| `history-rewrite` `{old_head, new_head, history, verification}` | `reconciliation` and rebase handoffs |
| `design-reopen` with a suspension reference, `issue-resume` | suspension and handoff evidence |
| `delivery-record` | delivery journal events (references still opaque; see section 9) |
| `validation-start`, `validation-record`, `validation-invalidate` | validation history and feature evidence |
| `artifact-put`, `artifact-get` | store and read blobs (no entry is appended) |
| `feature-close` | `scaffold clean` |

Not yet a separate entry type: `amendment.approved`. Pi's `delivery-amendment` evidence is stored as an
artifact and cited by the delivery journal's `apply_amendment` update.

`history-foreign` and `history-rewrite` are the two ways Git history may legitimately contain
something that is not a task checkpoint. Everything that is currently a special case in
`checkpointHistory()` (adoption, rebase, interrupted rebase, and the not-yet-handled mid-flight and
merge cases) becomes one of these two entries.

### 3.4 What Scaffold enforces

Scaffold's state machine becomes the home of rules now scattered across Pi.

* `direction-approve` takes the digest of the feature definition **and its instance**. Scaffold computes the
  digest itself (exposed as `direction_scope` in responses) and rejects a mismatch. `start` is refused until
  the approval matches. This removes `requireFeatureAuthorization` from every Pi call site.
* `attempt-record` is accepted only for the active task, in sequence, and idempotently.
* `complete` must cite the receipt of a recorded `PASSED` attempt of that task.
* `checkpoint-record` requires the task completed and `parent` equal to the ledger's `head`, so
  checkpoints form one chain from the original baseline.
* `history-foreign` and `history-rewrite` are accepted only between tasks and must continue the chain.
* `validation-start` requires the validated `head` to equal the recorded `head`, so the ledger accounts for
  every commit; `validation-record` (PASSED) requires every task completed and checkpointed.
* The feature definition is immutable, so an approval cannot silently stop matching; a recreated instance
  has a different scope digest and needs its own approval.

### 3.5 What stays in Pi, and the limit of what is verified

Pi still owns everything that needs Git, the Executor or the reviewer:

* Before appending `checkpoint-record`, Pi confirms the tree and parent in Git.
* Before appending `history-foreign` or `history-rewrite`, Pi confirms ancestry and mapping, and
  obtains the user's approval through the UI, and stores that approval as an artifact.
* Pi stores each receipt as an artifact and records the attempt; Scaffold records what Pi submits.

**Honest limit:** the chain makes edits to history detectable. It does not stop a process with
write access to `.scaffold/` from appending a forged entry, and Scaffold cannot inspect the truth of
a review verdict. Approval entries are only as trustworthy as Pi's UI confirmation. Signing would
change this and is deliberately out of scope.

### 3.6 History verification (replaces `checkpointHistory`)

Scaffold keeps `feature.history`, the ordered segments from the original baseline to `feature.head`, and
`feature.epochs`, the segment lists replaced by earlier rewrites. Each segment is a `checkpoint`
(`task_id, commit, parent, tree`) or a `foreign` range (`from, to, source, commits`). Scaffold guarantees
the segments form one unbroken chain and that nothing is recorded while a task is active.

Pi verifies that chain **against Git**: walk first-parent history from HEAD to the original baseline; every
commit must be a recorded checkpoint whose parent and tree match Git, or a commit inside a recorded foreign
range. Anything else is drift, which `inspect_feature_drift` already reports. Every completed task must have a
checkpoint, and checkpoint order must respect task prerequisites, as today.

The commit trailer shrinks to `Pi-Checkpoint: <task>`. Verification does not depend on it, but it survives
a rebase and lets Pi propose the old-to-new mapping automatically.

Review scope is unchanged: final validation reviews baseline to HEAD, and the requirements list
`history-foreign` ranges as unverified and in scope. Nothing is exempted.

### 3.7 Retention

No `refs/pi-*` namespaces. A rewrite stores the old and new history in the ledger (`epochs`). Suspension
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

1. **Scaffold: done, in review ([scaffold#22](https://github.com/jared-two-foxes/scaffold/pull/22)).** Ledger,
   schema v3, the rules in 3.4, artifact API, `clean` as `feature-close`, tests, README.
2. **Pi, storage layer:** an adapter over the Scaffold CLI for ledger actions and artifacts. Evidence
   receipts become artifacts; `retainEvidence`/`readEvidence` callers move to `artifact-put`/`artifact-get`.
3. **Pi, verification:** ledger-based history verification (3.6) replaces `checkpointHistory`;
   `checkpoint_verified_task`, `execute_and_review` and `validate_feature` ported;
   `adopt_feature_baseline` and `reconcile_feature_rebase` replaced by tools that append `history-foreign`
   and `history-rewrite`; the interrupted-task rebase flow becomes a combination of the two.
4. **Pi, deletion:** the evidence store, every `refs/pi-*` family, `lib/authorization`, and the embedded
   feature copies.
5. **Docs and CI:** update `ARCHITECTURE.md`, `RECOVERY.md`, skills and `SYSTEM.md`; point this repository's CI
   at the Scaffold branch until scaffold#22 merges.

**Sequencing:** this repository's CI checks out the latest Scaffold `main`. The two pull requests are
reviewed in parallel; merging Scaffold first leaves this repository's Pi integration tests failing until the
Pi port merges. That is accepted.

**Testing risk:** dozens of Pi tests (78 in my local run) are skipped unless real Scaffold is present. The new
design depends on Scaffold more, so the ported integration tests must run against real Scaffold in CI.

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
* Removal of the newest whole entries is not detectable by the chain. Only an external copy of the head hash
  could notice. A test in Scaffold documents this limit.
* Python 3.11 and Windows behaviour of the Scaffold ledger (file locking, symlink handling) is not yet verified.

## 9. Changes from the first draft of this design

| First draft | Implemented | Why |
|---|---|---|
| Entries reference other entries by hash | References are artifact digests (`sha256:`) | An entry cannot cite its own hash |
| Entry types named `task.completed`, `history.foreign`, ... | Entry `type` is the action name (`complete`, `history-foreign`, ...) | Reuses Scaffold's existing action vocabulary and CLI |
| `history.foreign` field `kind` | `source` | A payload `kind` overwrote the segment's own `kind` marker; found by a test |
| `checkpoint.recorded` carried only the task and commit | Carries `commit, parent, tree, reference` | Lets Scaffold enforce one unbroken chain without seeing Git |
| `history.rewritten` carried a commit mapping | Carries the complete replacement segment list | Scaffold can verify kind, task and chain continuity structurally |
| `direction.approved {scope_digest, capabilities}` required | `capabilities` optional | The set is constant; kept only for audit |
| Separate `amendment.approved` entry | Amendment evidence is an artifact cited by the delivery journal | Avoids reworking the journal before the Pi port shows what is needed |
| Delivery journal events become attempt entries | Journal unchanged; its `reference` fields are still opaque | Decide when porting the Pi side |
| `feature.closed` appended by `clean` | `feature-close` | Same, action-style name |
