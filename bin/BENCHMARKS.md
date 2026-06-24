# Model benchmarking for pipeline blocks

Tracks which opencode-zen model to use for each `pipeline_lib.py` block
(`plan`, `narrow`, `test-criterion`, ...), and the trial data behind each
choice, so future work can extend rather than re-derive this.

## Harness

- [bench.py](bench.py) - orchestrator. Runs N trials per model, each in its
  own git worktree (so concurrent trials never clobber `.ticket.md` /
  `.tdd-plan.md` / `.gap-plan.md`, or each other's file edits).
- [bench_block.py](bench_block.py) - subprocess invoked per trial. Calls one
  `pipeline_lib` block function directly against fixed fixture inputs (not
  whatever a live upstream step produced - isolates "is this model good at
  block X" from "did the step before it hand block X a good or bad input"),
  then grades the result and prints one JSON line.
- [fixtures/sa452/](fixtures/sa452/) - ticket + plan + gap-plan fixtures for
  the SA-452 scenario (Xero/QuickBooks webhook config: existing
  `accounting_webhooks.rs` already implements the structs, but lacks Debug
  redaction - the known failure mode is models proposing to split it into
  new per-struct files instead of fixing the existing one in place).
  - `ticket.md`, `plan-good.md`, `plan-bad.md`, `gapplan-good.md` - inputs
    for `plan`/`narrow`/`test-criterion`, described above.
  - `test-debug-redaction.rs` + `test-debug-redaction.meta.json` - a known-
    good *output* of `test-criterion`, captured from a passing gpt-5.4-mini
    trial: the full `accounting_webhooks.rs` with the failing test already
    appended (compiles, fails red against the unfixed code). This is the
    input `implement-criterion` benchmarking needs - copy this file over
    `target_file` (from the `.meta.json`) in the worktree before running
    that block, so the worktree starts in the state `run_test_for_criterion`
    would have left it in. `qualified_test_name` in the `.meta.json` is the
    green-check target for grading; `target_file` is also what
    `run_implement_for_criterion`'s `protected_paths` needs, to stop the
    implementer from editing the test it's supposed to satisfy.
- [fixtures/sa500/](fixtures/sa500/) - the **"standard"/easy baseline**
  fixture, deliberately without a trap: add one new field
  (`webhook_retry_rate_limit`) to the existing `RateLimitConfig` in
  `infra/rate_limit_config.rs`, following an established pattern exactly
  (mirrors the field-per-env-var shape every other field there already
  uses). No ambiguity about file location, no security/secrets concerns,
  no plausible reason for a model to do anything but the obvious thing.
  Exists to catch the case SA-452 can't: a model that's bad at *everything*,
  not just at reconciling stale ticket paths. A FAIL on SA-500 is a much
  stronger signal than a FAIL on SA-452.
  - `ticket.md`, `plan-good.md`, `gapplan-good.md` - same shape as SA-452's.
    No `plan-bad.md`: there's no known plausible mistake to encode as a
    trap fixture (that's the point), so `narrow` benchmarking for SA-500
    should pass `--plan-fixture good` explicitly rather than `both`.
  - No `test-debug-redaction.rs`/`.meta.json` equivalent yet - capture one
    the same way SA-452's was captured (see the implement-criterion bullet
    above) before benchmarking `implement-criterion` against this ticket.

`--fixtures-dir` defaults to `fixtures/<--ticket-name>/`, so
`--ticket-name sa500` alone is enough to point everything at the right
fixtures - only pass `--fixtures-dir` to override.

### Usage

```
python bench.py --block plan --models gpt-5.4-mini,deepseek-v4-pro --trials 10 --concurrency 8
python bench.py --block narrow --models glm-5,gpt-5.1 --trials 3 --plan-fixture both
python bench.py --block test-criterion --models gpt-5.4-mini,kimi-k2.6 --trials 3
```

Results stream to stdout and to a `results.jsonl` (`--out` to name it, else
timestamped). Always inspect the per-trial `reason` strings, not just the
pass-rate table - they're the actual signal when something looks off.

### Grading

- `plan` / `narrow`: text heuristic in `bench_block.py`'s `GRADERS` dict,
  keyed by `(ticket_name, block)`. For SA-452 it's `grade_sa452_no_file_split`
  - checks the output doesn't propose new `xero_webhook_config.rs` /
    `quickbooks_webhook_config.rs` files and does reference the real
    `accounting_webhooks.rs`. Cheap, but it's pattern matching, not ground
    truth - spot-check the `reason` text periodically.
- `test-criterion`: real check, not a heuristic. Compiles the test the model
  wrote (`cargo test --no-run`) and runs it scoped (`cargo test {filter}`),
  requiring it to fail (red) - a criterion that isn't implemented yet should
  produce a real failure, not a compile error and not an accidental pass.

### Known gotchas (read before re-running or extending)

1. **`git worktree add`/`remove` are not safe to run concurrently** against
   the same repo - bench.py serializes just those two calls behind
   `_WORKTREE_LOCK`. The worktrees themselves run fully in parallel once
   created.
2. **`test-criterion` needs `DATABASE_URL`** - sqlx's compile-time
   `query!` macros introspect schema against a real DB file. The repo's
   `.env` + `database.db` are both gitignored, so a fresh worktree has
   neither. Sharing one `database.db` across concurrent trials looked safe
   (read-only) but caused intermittent SQLite lock contention that
   surfaced as bogus "type annotations needed" compile errors - fixed by
   copying `database.db` into each worktree so every trial gets its own
   file.
3. **`test-criterion` concurrency is capped at 1 by default.** Running
   multiple full `cargo test --no-run` workspace compiles at once exhausted
   this machine's pagefile and produced corrupted builds (linker
   `STATUS_STACK_BUFFER_OVERRUN`, bogus "crate required in rlib format"
   errors) - a real resource ceiling, not a logic bug. Separate
   `CARGO_TARGET_DIR` "lanes" per concurrency slot exist (so compiles stay
   warm without lanes colliding) but don't fix the underlying memory
   exhaustion from N simultaneous `rustc`/linker processes. Pass
   `--allow-concurrent-cargo` only if you've confirmed the machine can
   take it.
4. **`plan`/`narrow` results need ~10 trials to trust, not 3.** Several
   models looked perfect at n=3 (deepseek-v4-pro, claude-haiku-4-5, gpt-5.1
   all 3/3 on `plan`) and then dropped to 60-70% at n=10. `gpt-5.4-mini` is
   the only model that has held up at every trial count tested (3, 10, 25 -
   35/35 total). Don't ship a model choice off a 3-trial run.
5. **A bad plan can poison narrow inconsistently, not reliably.** Feeding
   the same bad plan fixture to the same narrow model sometimes gets fully
   corrected, sometimes partially hedged, sometimes fully inherited -
   narrow's "recovery" behavior isn't dependable. The real fix for the
   file-split failure mode is a reliable `plan`, not a narrow model that
   can rescue a bad one.
6. **Model strength is step-specific - not transferable, not price-tiered.**
   Every block has produced at least one surprise (a cheap model beating an
   expensive one, or a model great at one block failing hard at another).
   Don't assume a model that wins one block will win another - bench it.

## Results by block

### `plan` (resolves ticket -> implementation plan)

Grader: `grade_sa452_no_file_split`.

| Model | Trials | Pass rate | Avg cost | Avg time |
|---|---|---|---|---|
| **gpt-5.4-mini** | 35 (10 + 25) | **35/35** | $0.057 | 32s |
| deepseek-v4-pro | 10 | 7/10 | $0.132 | 90s |
| claude-haiku-4-5 | 10 | 6/10 | $0.128 | 35s |
| gpt-5.1 | 10 | 6/10 | $0.143 | 92s |
| gpt-5.4-nano | 3 | 1/3 | $0.036 | 79s |
| glm-5.2 | 3 | 1/3 | unpriced at test time | 121s |
| glm-5.1 | 3 | 1/3 | $0.081 | 92s |
| grok-build-0.1 | 3 | 1/3 | $0.094 | 140s |
| kimi-k2.6 | 3 | 0/3 | $0.189 | 70s |
| glm-5 | 3 | 0/3 | $0.063 | 30-120s (variable) |
| deepseek-v4-flash | 3 | 0/3 | $0.008 | 39s |
| gemini-3.5-flash | 0 | N/A - HTTP 401 "No provider available" (persistent, both attempts) | - | - |
| gemini-3.1-pro | 0 | N/A - same | - | - |

**Current default: `gpt-5.4-mini`** (set in `check-ticket.py` / `resolve-ticket.py`).

A prompt fix was added to `prompts/plan.prompt.md` Step 3 (explicitly telling
the planner to verify ticket-named files against the actual codebase before
trusting them) - it measurably helped some failing cheap models
(deepseek-v4-flash 0/3 -> 2/3, kimi-k2.6 0/3 -> 1/3) but didn't reach
reliable for any of them, and didn't move glm-5 at all. Kept as a
general-quality improvement; not a substitute for using a reliable model.

### `narrow` (narrows plan -> only the unsatisfied criteria)

Grader: `grade_sa452_no_file_split` (same heuristic, applied to the gap plan).
Two fixtures: `plan-good.md` (correct, anchored in `accounting_webhooks.rs`)
and `plan-bad.md` (the file-split mistake) - tests both "does narrow get it
right from a clean plan" and "can narrow catch/recover from a bad one".

| Model | good-fixture (3 trials) | bad-fixture (3 trials) |
|---|---|---|
| **claude-haiku-4-5** | 3/3 | **3/3** |
| glm-5 | 3/3 | 2/3 |
| grok-build-0.1 | 3/3 | 2/3 |
| deepseek-v4-flash | 3/3 | 0/3 |
| deepseek-v4-pro | 3/3 | 0/3 |
| glm-5.1 | 3/3 | 0/3 |
| gpt-5.1 | 3/3 | 0/3 |
| kimi-k2.6 | 3/3 | 0/3 |

Every model is 3/3 on the good fixture - narrow is only hard when recovering
from a bad plan, which is exactly why a reliable `plan` matters more than a
narrow-model choice. `--narrow-model` was added then removed again (see git
history around `pipeline_lib.NARROW_DEFAULT_MODEL`) - narrow currently reuses
whatever `--model` is passed, defaulting to `gpt-5.4-mini` like `plan`.

### `test-criterion` (writes one failing test for one criterion)

Grader: real compile + scoped-run check (not a heuristic) - see above.
Fixture: `gapplan-good.md` + criterion `"- [ ] \`Debug\` output redacts the
secret values"`.

| Model | Trials | Pass rate | Avg cost | Avg time |
|---|---|---|---|---|
| **gpt-5.4-mini** | 3 | **3/3** | $0.025 | 140s |
| **gpt-5.4** | 3 | **3/3** | $0.114 | 168s |
| **claude-opus-4-8** | 3 | **3/3** | $0.137 | 144s |
| glm-5.1 | 3 | 2/3 | $0.057 | 205s |
| claude-sonnet-4-6 | 3 | 0/3 | $0.187 | 201s |
| deepseek-v4-pro | 3 | 0/3 | $0.098 | 198s |
| kimi-k2.6 | 3 | 0/3 | $0.102 | 214s |
| qwen3.6-plus | 3 | 0/3 | $0.059 | 220s |

Dominant failure mode for the 0/3 models: "test passed without
implementation - gap didn't reproduce" (a false green - the test compiled
but didn't actually exercise the missing behavior). `claude-sonnet-4-6`
going 0/3 while the cheaper `gpt-5.4-mini` and same-family `claude-opus-4-8`
both go 3/3 is the sharpest example yet that price tier doesn't predict
per-block reliability.

**No default changed yet for this block** - `gpt-5.4-mini` looks like the
front-runner (ties the two priciest models at a fraction of the cost) but
has only 3 trials here, not the ~10-25 that gave `plan`'s number real
confidence. Treat this table as a first pass, not a settled choice.

### `implement-criterion` (implements one criterion against its failing test)

Grader: real check, mirror of `test-criterion`'s - `cargo build` must
succeed, then the seeded test must pass when run scoped (green). Fixture:
`gapplan-good.md` + `test-debug-redaction.rs`/`.meta.json` (a known-good
*output* of `test-criterion`, captured from a passing gpt-5.4-mini trial -
the full `accounting_webhooks.rs` with the failing test already appended,
copied into the worktree before the implementer runs so it starts in the
state `test-criterion` would have left it in).

| Model | Trials | Pass rate | Avg cost | Avg time |
|---|---|---|---|---|
| gpt-5.4-mini | 1 (smoke test) | 1/1 | $0.065 | 410s |

Only smoke-tested so far (confirms the wiring works end to end - implements
the Debug redaction, compiles, scoped test goes green). Needs a real trial
batch (5-10+ per model, several models) before drawing any conclusion about
which model to default to here.

### `sa500` - the "standard"/easy baseline ticket

Grader: `grade_sa500_standard` - checks the plan/gap-plan references the
real `rate_limit_config.rs`, mentions the new field/env var, and doesn't
invent a new file for it. Only smoke-tested so far (`gpt-5.4-mini`, 1
trial each):

| Block | Model | Trials | Pass rate | Cost | Time |
|---|---|---|---|---|---|
| plan | gpt-5.4-mini | 1 | 1/1 | $0.015 | 12s |
| narrow (good fixture) | gpt-5.4-mini | 1 | 1/1 | $0.008 | 121s |

Notably faster than the equivalent SA-452 `plan` trial (12s vs ~30-100s) -
consistent with this being a genuinely simple task with nothing to puzzle
over. The real value of this fixture comes from running the models that
*failed* SA-452 against it: if a model fails SA-500 too, that's a much
stronger signal (it's bad in general, not just at reconciling a stale
ticket path) than failing SA-452 alone suggested.

## How to extend this

- **More trials on an existing model/block**: rerun with a higher `--trials`
  count and append the new numbers to the relevant table above - note the
  combined trial count (like `plan`'s "35 (10 + 25)"), not just the latest
  batch, since pass rate at n=3 has repeatedly been misleading.
- **A new model**: add pricing to `model-pricing.toml` first if you want
  real cost numbers instead of token counts; some models in opencode zen's
  `/v1/models` list 401 ("No provider available") - that's been persistent,
  not transient, for the Gemini models tried so far, so don't burn retries
  assuming it'll clear up.
- **A new block** (e.g. `review`): add a grader to `bench_block.py`'s
  dispatch (text heuristic if cheap/fast is enough, real compile/run check
  if not - see `implement-criterion`'s compile+green check for the pattern
  to follow), wire the new `--block` choice through `bench.py`'s
  `build_jobs`/argparse/`CARGO_BLOCKS` (if it touches cargo), and add
  whatever fixture that block needs under `fixtures/<ticket>/`.
- **`implement-criterion` is wired but unbenchmarked** - it exists (see
  table above) but only has a 1-trial smoke test. Next step here is a real
  trial batch, same as was done for `plan`/`narrow`/`test-criterion`.
- **A new ticket scenario** (beyond SA-452): add a `fixtures/<ticket-name>/`
  directory with the same fixture shape (`ticket.md`, `plan-good.md` /
  `plan-bad.md` for narrow, `gapplan-good.md` for test-criterion), and a
  grader function keyed by that ticket name. Multiple ticket scenarios would
  catch failure modes specific to one ticket's shape rather than
  over-indexing on SA-452's file-split issue specifically.
- **Raise `test-criterion` concurrency**: only after confirming the
  machine's pagefile/RAM can take N concurrent full-workspace `cargo`
  compiles - see gotcha #3. Don't just pass `--allow-concurrent-cargo`
  without checking.
