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
- [fixtures/sa501/](fixtures/sa501/) - **omission-within-one-file** trap:
  add a new secret field (`postmark_signing_secret`) to `EmailConfig`
  (`notifications/email_config.rs`), whose `Debug` impl is hand-written
  (not `#[derive(Debug)]`). A plan that adds the field without explicitly
  naming the existing Debug impl as needing an update would leak the
  secret in cleartext by default - there's no automatic derive to fall
  back on. Different failure shape than SA-452 (one file, an easy-to-miss
  manual detail, not file fragmentation).
  - `ticket.md`, `plan-good.md` - same shape as SA-500's (no plausible
    plan-bad.md trap distinct from the plan grader itself).
- [fixtures/sa502/](fixtures/sa502/) - **"this is already done"** trap:
  the ticket asks for validation behavior
  (`quote_resend_rate_limit`'s env var parsing/error handling) that's
  already fully implemented via the shared `parse_u32_or_default` helper,
  with existing tests covering every acceptance criterion. Tests whether
  a plan recognizes "no new work needed" instead of inventing redundant
  test coverage or new validation logic for something that already works.
  - `ticket.md`, `plan-good.md` - same shape as above.

`--fixtures-dir` defaults to `fixtures/<--ticket-name>/`, so
`--ticket-name sa500` alone is enough to point everything at the right
fixtures - only pass `--fixtures-dir` to override.

### Fixture pinning (`fixture.json`)

Every fixture (ticket text, plan, gap plan, captured test/implement
outputs) encodes assumptions about the exact state of the target repo
(`--repo`, default `~/code/own/VirtualAssistant`) at the moment it was
captured - which fields exist on a struct, which files construct it,
even error message line numbers a grader might match against. That repo
is someone's live, moving codebase, not a frozen fixture store. Before
fixture pinning existed, `--base-ref` defaulted to `HEAD` - meaning the
same fixture silently pointed at a different commit every time main
moved, so a bench failure could mean "the model got it wrong" or "the
fixture no longer matches the code" with no way to tell which from the
numbers alone, and results from last week weren't reproducible today.

Each fixture directory now has a `fixture.json` pinning the exact commit
it was authored/validated against:

```json
{"base_ref": "<full commit sha>", "repo": "VirtualAssistant", "pinned_on": "<date>", "note": "..."}
```

`bench.py` reads this automatically (`resolve_fixture_base_ref`) whenever
`--base-ref` isn't passed explicitly, and prints which ref it's using.
Fixtures without a `fixture.json` still work - falls back to `HEAD` with
a printed warning - so this is additive, not a breaking requirement.

**Re-pinning a fixture deliberately** (e.g. because the target repo
changed in a way that's relevant to this fixture's scenario): re-validate
the fixture's ticket/plan/criterion text still describes reality at the
new commit first (the struct/file/criterion it's testing may have moved
or changed shape), *then* update `base_ref` - don't just bump it blindly.
If the fixture's assumptions no longer hold at all, treat it as needing a
new fixture, not a re-pin.

**`--base-ref` still overrides the pin** when passed explicitly - useful
for intentionally re-validating an existing fixture against the repo's
current `HEAD` to check whether it's drifted, without committing to a
new pin until you've confirmed the result still makes sense.

Currently pinned: `sa452` and `sa500` are both pinned to
`1737072afce89e118a3b4aee5c3a8419718ee8b1` (2026-06-24), the commit they
were captured against.

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
| copilot:gemini-3.1-pro-preview | 3 | 1/3 | unpriced (Copilot subscription, see below) | 114s |
| copilot:gemini-2.5-pro | 3 | 0/3 | unpriced | 21s |
| copilot:gemini-3-flash-preview | 3 | 0/3 | unpriced | 107s |
| copilot:gemini-3.5-flash | 3 | 0/3 | unpriced | 136s |

The original `gemini-3.5-flash`/`gemini-3.1-pro` rows (via opencode zen) were
N/A - persistent HTTP 401 "No provider available" on every attempt. Once the
Copilot provider (see `ai_client.py`'s `Provider`/`PROVIDERS`) was added,
re-running the same scenario via `copilot:gemini-*` model ids worked
mechanically (no provider/auth errors) but the models themselves hit
SA-452's known file-split failure mode at a similar rate to the other
budget-tier models above - getting unblocked from a provider error didn't
turn out to mean these models are actually good at this block. Cost shows
as unpriced because Copilot bills via a flat subscription + per-model
premium-request multiplier, not $/token - `model-pricing.toml` intentionally
has no `copilot:*` entries (see `ai_client.py`'s `COPILOT` comment); treat
"unpriced" here as "billed differently," not "free."

**Current default: `gpt-5.4-mini`** (set in `check-ticket.py` / `resolve-ticket.py`).

A prompt fix was added to `prompts/plan.prompt.md` Step 3 (explicitly telling
the planner to verify ticket-named files against the actual codebase before
trusting them) - it measurably helped some failing cheap models
(deepseek-v4-flash 0/3 -> 2/3, kimi-k2.6 0/3 -> 1/3) but didn't reach
reliable for any of them, and didn't move glm-5 at all. Kept as a
general-quality improvement; not a substitute for using a reliable model.

#### `sa501` (omission-within-one-file: secret field needs a manual Debug update)

Grader: `grade_sa501_debug_redaction_named`.

| Model | Trials | Pass rate | Avg cost | Avg time |
|---|---|---|---|---|
| claude-haiku-4-5 | 3 | 3/3 | $0.041 | 20s |
| deepseek-v4-pro | 3 | 3/3 | $0.105 | 67s |
| glm-5.1 | 3 | 3/3 | $0.053 | 51s |
| gpt-5.1 | 3 | 3/3 | $0.032 | 43s |
| gpt-5.4-mini | 3 | 3/3 | $0.045 | 24s |
| kimi-k2.6 | 3 | 3/3 | $0.115 | 91s |

Every model went 18/18 at first - but this turned out to be a **fixture
problem, not a model-capability finding**. The original `ticket.md` named
the trap directly in its own acceptance criteria: *"The new field's value
never appears in plaintext anywhere it could end up in logs (**Debug
output**, error messages, etc.)"* - so passing only required following an
explicit instruction, not noticing the hand-written `Debug` impl
unprompted. That line was removed (2026-06-26) and the fixture re-run
against the same 6 models:

| Model | Trials | Pass rate |
|---|---|---|
| claude-haiku-4-5 | 3 | 3/3 |
| deepseek-v4-pro | 3 | 3/3 |
| glm-5.1 | 3 | 3/3 |
| gpt-5.1 | 3 | 3/3 |
| gpt-5.4-mini | 3 | 2/3 |
| kimi-k2.6 | 3 | 3/3 |

17/18 instead of 18/18 - a much weaker signal than SA-502, but no longer a
pure no-op, and `gpt-5.4-mini` is again the one that slips.

**General lesson for writing these fixtures**: a trap only measures
judgment if the acceptance criteria don't pre-state the answer. Before
trusting a "not discriminating" result as a real finding about model
capability, re-read the ticket text itself for any phrase that hands the
model the exact thing the grader checks for - that's a leaky fixture, not
a strong model.

#### `sa502` ("this is already done" - recognizing already-satisfied work)

Grader: `grade_sa502_already_implemented`.

| Model | Trials | Pass rate | Avg cost | Avg time |
|---|---|---|---|---|
| **claude-haiku-4-5** | 3 | **2/3** | $0.050 | 25s |
| **glm-5.1** | 3 | **2/3** | $0.097 | 98s |
| deepseek-v4-pro | 3 | 1/3 | $0.149 | 147s |
| gpt-5.1 | 3 | 0/3 | $0.148 | 160s |
| gpt-5.4-mini | 3 | 0/3 | $0.060 | 41s |
| kimi-k2.6 | 3 | 0/3 | $0.180 | 205s |

The sharpest result yet: **`gpt-5.4-mini` - the model with a flawless 35/35
on SA-452/plan and the current pipeline default - goes 0/3 here**, while
the smaller/cheaper `claude-haiku-4-5` and `glm-5.1` do best. Dominant
failure mode (`reason` text, verified by hand against one trial's full
output): the model correctly finds `rate_limit_config.rs` and
`quote_resend_rate_limit`, even correctly identifies the right helper
function and existing test names, but still writes "add/adjust unit
coverage" and proposes a brand-new integration test for a startup-panic
path that doesn't exist anywhere else in the codebase - real scope creep
on a ticket that needed zero new code, not a wording quirk the grader
missed. This is a materially different failure mode than SA-452's file-
split trap (over-eager invention of work vs. fragmenting an existing
file) and the strongest evidence so far that per-scenario reliability,
not just per-block reliability, has to be measured separately - a model
winning SA-452 tells you nothing about SA-502.

**No default change recommended off 3 trials** - but this result alone is
reason to add more trials here before trusting `gpt-5.4-mini` as broadly
reliable for `plan`, not just reliable on the one scenario it's been
tested against the most.

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

#### Sub-finding: the compile-red gate has a structural blind spot

`test-criterion`'s grader requires the test to *compile* and then fail
red. That's correct when the criterion is about wrong/missing
*behaviour* on an existing API (SA-452's case: `Debug` exists, the
redaction doesn't). It breaks down when the criterion names a field/
function that has no declaration anywhere yet (SA-500's case: testing
`RateLimitConfig.webhook_retry_rate_limit`, where the field itself
doesn't exist) - a test that references it as written can't compile at
all, and a compile error proves nothing about the behaviour under test.
Running the 4 leading models from the table above against SA-500
confirmed this: all 4 failed with `no field webhook_retry_rate_limit`
compile errors (`gpt-5.4`/`gpt-5.4-mini` 1/3, `claude-opus-4-8`/
`glm-5.1` 0/3) - a fixture/grader gap, not a model-quality signal.

Fix: `prompts/test-criterion.prompt.md` Step 3 now lets Tester add a
**new accessor/constructor function** as scaffolding when this happens
(e.g. `parse_webhook_retry_rate_limit()` with a `todo!()`/wrong-default
body) - real signature, deliberately wrong behaviour, just enough to
turn a compile error into a real red. Explicitly forbids adding the
field itself: an accessor is purely additive (nothing else in the
codebase calls it yet, so nothing can break), but a new/changed *field*
can silently break every other struct-literal construction site of that
type that doesn't use `..Default::default()` - confirmed by an earlier
version of this fix that allowed the field fallback and made things
*worse* (1/12 pass across the same 4 models, with the new failure mode
being unrelated files failing to compile via `E0063: missing field` at
other construction sites Tester had no way to find by reading alone).
Re-running accessor-only: `gpt-5.4-mini` 3/3 (was 1/3), confirming the
fix. `gpt-5.4`/`claude-opus-4-8`/`glm-5.1` had mixed/failed results in
the same batch but on isolated retry (`claude-opus-4-8`, 1 trial)
passed cleanly - the batch failures were a transient API outage
(uniform ~14s/$0 aborts across all of that batch's trials for those
two models), not the prompt change.

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

| Model | Ticket | Trials | Pass rate | Avg cost | Avg time |
|---|---|---|---|---|---|
| gpt-5.4-mini | sa452 | 1 (smoke test) | 1/1 | $0.065 | 410s |
| gpt-5.4-mini | sa500 | 1 (smoke test) | 1/1 | $0.690 | 457s |

Only smoke-tested so far (confirms the wiring works end to end). Needs a
real trial batch (5-10+ per model, several models) before drawing any
conclusion about which model to default to here.

A second sa500 fixture (`fixtures/sa500/test-webhook-retry-rate-limit.rs`/
`.meta.json`) was added alongside sa452's, captured the same way - the
seeded test exercises a *new* accessor method (`webhook_retry_rate_limit()`,
added by `test-criterion`'s scaffolding allowance, see above) rather than
sa452's existing-field case, so it stresses a different implementer path:
"add the real field this accessor was standing in for" instead of "fix
existing buggy behaviour."

The first sa500 smoke test (pre-fix) failed: `gpt-5.4-mini` added
`webhook_retry_rate_limit` as a real struct field on `RateLimitConfig` but
didn't find/fix the other struct-literal construction site at
`rate_limiter.rs:442` that builds it without `..Default::default()` -
`E0063: missing field`. Same root cause as `test-criterion`'s field-fallback
regression above, surfacing one step later: nothing in
`implement-criterion.prompt.md` told Implementor to look beyond the plan's
named files for other places that construct a type it's adding a field to.

Fix: added a step requiring `search_files` for the type's name across the
whole project (not just plan-named files) before finishing, fixing every
other construction site found, with that search called out explicitly in
the final report. Re-ran: 1/1 pass, compiles and goes green - cost/time
roughly doubled ($0.39->$0.69, 279s->457s) versus the failed attempt,
consistent with the added reconciliation work, and worth it since the
alternative was a build that doesn't compile at all.

#### Sub-finding: `protected_paths` made the task impossible for inline tests

Running the codegen-strength models (`claude-opus-4-8`, `gpt-5.4`) against
this same fixture turned up a second, more serious bug: `test_file` was
fully blocked via `protected_paths` to stop Implementor from tampering
with the test it's supposed to satisfy - but when the test lives inline in
the same file as the production code (Rust's `#[cfg(test)] mod tests`,
this fixture's own convention, and the example the Tester prompt itself
names), that *is* the file Implementor must edit. Blocking it entirely
made the task structurally impossible, not safe. `claude-opus-4-8` hit
`write_file` returning "refused to overwrite protected file", got nothing
through, and aborted with "Implementor finished without writing any
files" at $0.17-0.35/trial (2/2 in the codegen batch) - a fast, cheap,
uniform failure that looked at first like a model-quality gap but wasn't.
`gpt-5.4-mini` happened to dodge it by splitting the implementation into a
new file (`rate_limit_config_impl.rs`) and re-exporting via `mod.rs` - a
real workaround, not evidence the model was more capable, just luckier in
how it interpreted the constraint.

Fix: `run_implement_for_criterion` (`pipeline_lib.py`) no longer protects
the whole file. It snapshots the named test function's exact source
(`_extract_function_block`, a generic brace-counting extractor - works for
Rust/TS/JS/C++/Java/Go, best-effort no-op for non-brace languages) before
the run and verifies byte-for-byte afterward that it's unchanged, failing
clearly if it was altered or removed. `implement-criterion.prompt.md` now
tells Implementor explicitly that it may edit the file around an inline
test, just never the test itself, and that this is checked mechanically.
Both callers (`resolve-ticket.py`, `bench_block.py`) updated to pass
`qualified_test_name` through.

Re-ran `claude-opus-4-8` after the fix: no longer blocked - got all the way
to a real compile/test outcome, and the integrity check passed silently
(no tampering). It still failed, but for a *different, genuine* reason:
declared the new field without `pub`, so other modules' `RateLimitConfig {
..Default::default() }` sites failed with `E0451: field is private`
(Rust's struct-update syntax requires every field be visible from outside
the defining module) - $5.04/647s, expensive but a real model mistake
this time, not a harness bug. This is the kind of failure the benchmark is
supposed to be measuring; the earlier instant aborts were not.

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

### `plan-narrow` (merged plan+narrow, single model session, single artifact)

Experimental alternative to running `plan` and `narrow` as two separate
sessions (see `pipeline_lib.run_plan_narrow_step` /
`prompts/plan-narrow.prompt.md`). Produces only `.gap-plan.md` - no
separate `.tdd-plan.md` - since the only consumer of the full plan
(`run_review_gate`'s "review against full ticket scope") doesn't need
criteria that are already satisfied and untouched. Also drops narrow's
host-run command-evidence gathering entirely (`extract_plan_commands`/
`gather_build_status`, removed from `pipeline_lib.py`): that machinery
never provided a durable guarantee anyway - a criterion it found
"passing" had no protection against a *later* criterion's
implementation regressing it. The real fix for that gap was adding a
full-suite `test_cmd` gate to `resolve-ticket.py` before its review gate
(unrelated to this experiment, but a prerequisite for trusting that
dropping command-evidence here doesn't weaken anything).

Graded with the same heuristics as `plan`/`narrow` (`GRADERS` keyed by
`(ticket, "plan-narrow")`, pointing at the same grader functions).

| Ticket | Model | Trials | Pass rate | Avg cost | Avg time |
|---|---|---|---|---|---|
| sa452 | gpt-5.4-mini | 3 | 3/3 | $0.060 | 41s |
| sa452 | claude-haiku-4-5 | 3 | 3/3 | $0.243 | 68s |
| sa500 | gpt-5.4-mini | 3 | 3/3 | $0.032 | 26s |
| sa500 | claude-haiku-4-5 | 3 | 3/3 | $0.024 | 26s |
| sa501 | gpt-5.4-mini | 3 | 3/3 | $0.066 | 49s |
| sa501 | claude-haiku-4-5 | 3 | 3/3 | $0.064 | 38s |
| sa502 | gpt-5.4-mini | 3 | **0/3** | $0.057 | 44s |
| sa502 | claude-haiku-4-5 | 3 | **0/3** | $0.099 | 44s |

**Cost/time vs. the two-step baseline**: on sa452, merged cost
($0.060/41s for gpt-5.4-mini) lands close to `plan` alone's existing
35-trial average ($0.057/32s) - i.e. narrowing is riding along nearly
free instead of costing a second full session. sa500/sa501 show a
similar pattern against their smoke-tested plan+narrow totals. This is
the efficiency win the experiment was looking for, on every fixture
where both steps agreed (sa452, sa500, sa501) - but see sa502 below for
where the merge costs something other than money.

**sa502 regression - the merge fails the "already implemented" trap
that the two-step `plan` block didn't fail as hard.** `plan` alone
scored `claude-haiku-4-5` 2/3 and `gpt-5.4-mini` 0/3 on this same trap
(see the `plan`/sa502 table above); merged `plan-narrow` goes 0/3 for
*both* models. Inspecting one trial's actual output (`gpt-5.4-mini`,
read tools traced `rate_limit_config.rs`/`rate_limiter.rs`/the existing
test file correctly): instead of recognizing every criterion is already
satisfied and emitting `(none - all criteria satisfied)`, it retained a
vague, ungrounded criterion ("`cargo test -p virtual_assistant_api`
passes with tests covering the above") with an Implementation Plan entry
about "resolving any package-test failures" - never naming
`rate_limit_config.rs` or `quote_resend_rate_limit` in the surviving
text at all, despite having read both correctly during evidence
gathering. The narrowing judgment (this is already done) and the
evidence-gathering (these are the right files) happened correctly in the
trace, but didn't survive into Step 4 (build the plan from what's left)
- doing "extract criteria" and "judge each one against the codebase" as
one continuous pass seems to make it easier for the model to lose track
of *why* it kept a criterion by the time it writes the final entry,
something the two-step path's narrow-as-its-own-focused-pass apparently
resists better. Not enough trials to call this conclusive (n=3), but
it's a real, reproducible failure mode, not a grader artifact - inspected
the raw `.gap-plan.md` directly, not just the heuristic's verdict.

**No default change recommended.** The merge is a real cost/time win on
every fixture except sa502, where it strictly underperforms the unmerged
`plan` block at the same trial count. Before swapping `check-ticket.py`/
`resolve-ticket.py` over: run more trials on sa502 specifically (n=3 is
exactly the count this file's own guidance says not to trust), and try
whether restructuring Step 4 of `plan-narrow.prompt.md` (e.g. requiring
the file/symbol citation to be repeated in the retained criterion's "why"
comment, not just during evidence-gathering) recovers the sa502 result
without regressing the other three.

#### Re-run with `repo_context.py` seeded in (see that section below)

Once `repo_context.gather_repo_context()` replaced the bare
`tools.list_dir(".")` root listing in `build_plan_narrow_prompt`, re-ran
the same 4 fixtures (3 trials, same 2 models) to see whether richer
upfront orientation changes anything:

| Ticket | Model | Trials | Pass rate | Avg cost | Avg time |
|---|---|---|---|---|---|
| sa452 | gpt-5.4-mini | 3 | 3/3 | $0.073 | 43s |
| sa452 | claude-haiku-4-5 | 3 | 2/3 | $0.251 | 67s |
| sa500 | gpt-5.4-mini | 3 | 3/3 | $0.042 | 30s |
| sa500 | claude-haiku-4-5 | 3 | 3/3 | $0.023 | 28s |
| sa501 | gpt-5.4-mini | 3 | 3/3 | $0.071 | 54s |
| sa501 | claude-haiku-4-5 | 3 | 2/3 | $0.079 | 36s |
| sa502 | gpt-5.4-mini | 3 | **0/3** | $0.068 | 50s |
| sa502 | claude-haiku-4-5 | 3 | **0/3** | $0.070 | 36s |

**sa502 is unchanged - still 0/3 for both models, same failure mode**
("plan references the right field but never says this is already
implemented"). This is a useful negative result: it confirms the sa502
failure isn't an evidence-gathering problem (more upfront orientation
doesn't fix it), consistent with the earlier trace inspection showing
the model *did* find the right files - the bug is losing track of "why
this criterion was kept" between Step 3 (evidence-gathering) and Step 4
(writing the final answer), not insufficient context to find evidence
with in the first place. Don't expect a repo-context rollout to rescue
this particular failure mode.

The two single-trial `claude-haiku-4-5` losses on sa452/sa501 (one each,
both otherwise-passing fixtures) didn't reproduce on manual re-run of the
same fixture/model combination - one was a grader-side exception
(`TypeError` inside cost accounting, not the model's plan text) and the
other a clean pass on retry. Treat both as transient flake at this trial
count, not a `repo_context`-caused regression - cost/time on the
passing trials is in the same range as the pre-repo_context numbers
above, so the richer block isn't destabilizing the passing fixtures.

#### Re-run again with convention docs added (`AGENTS.md`/`CLAUDE.md`/etc.)

`repo_context.RepoContext` gained a `convention_docs` field -
`AGENTS.md`/`CLAUDE.md`/`.cursorrules`/`CONTRIBUTING.md`, whichever
exist at the project root, each capped at 4000 chars. VirtualAssistant
has a real `AGENTS.md` (4036 chars, truncated by 36 chars in practice -
right at the edge of the cap). Re-ran sa452/sa500/sa501 (skipped sa502 -
already a known-bad case unrelated to this addition):

| Ticket | Model | Trials | Pass rate | Avg cost | Avg time |
|---|---|---|---|---|---|
| sa452 | gpt-5.4-mini | 3 | 3/3 | $0.090 | 63s |
| sa452 | claude-haiku-4-5 | 3 | 3/3* | $0.159 | 55s* |
| sa500 | gpt-5.4-mini | 3 | 3/3 | $0.031 | 22s |
| sa500 | claude-haiku-4-5 | 3 | 3/3 | $0.017 | 23s |
| sa501 | gpt-5.4-mini | 3 | 3/3 | $0.063 | 39s |
| sa501 | claude-haiku-4-5 | 3 | 3/3 | $0.113 | 39s |

(*one of the 3 sa452 `claude-haiku-4-5` trials in the raw batch aborted
with `die()` triggered after exhausting retries; 3 sequential manual
reruns of the exact same fixture/model immediately after all passed
cleanly (71s/$0.34, 85s/$0.25, 89s/$0.28). This is the same
intermittent-under-4-concurrent-workers flake pattern seen earlier in
this file for `claude-haiku-4-5` specifically (see the sa501/sa452
re-run note above) - reported here as 3/3 from the sequential confirmation,
not the raw concurrent-batch number.)

All three pass cleanly with the convention doc included; cost/time
stayed in the same range as the tree-only `repo_context` numbers. No
sign that a real ~4KB `AGENTS.md` confused either model or pushed cost
up meaningfully - the addition looks safe to keep.

#### sa502 regression: root cause and fix

The first attempted fix (requiring the retained criterion's "why"
comment to cite a concrete file/symbol from Step 3, not just restate the
criterion) **did not fix sa502** - tracing a live `gpt-5.4-mini` run
afterward showed why the original diagnosis was wrong. The model had
correctly read the *entire* `rate_limit_config.rs` (260 lines, all in
context), correctly recognized the first 3 behavioral criteria as PASS,
and correctly dropped them. The 4th ticket criterion -
`` `cargo test -p virtual_assistant_api` passes with tests covering the
above`` - is verbatim from the ticket, not invented. Per the prompt's own
Step 3 rule ("you cannot run a command yourself, mark UNKNOWN if that's
not enough to confirm"), the model correctly retained it, since it
genuinely cannot execute `cargo test`. **The grader was penalizing
correct behavior** - this is exactly the command-criterion question from
the original plan/narrow-merge discussion (a blanket "tests pass"
restatement doesn't need independent tracking once everything it covers
is itself confirmed PASS, because a full-suite gate already enforces it
downstream regardless of what this document says) - that policy got
implemented as *removing the host-run command-evidence machinery*, but
the prompt itself never told the model it's safe to mark a
blanket-restatement command-criterion PASS once everything it references
checks out.

Fix (`prompts/plan-narrow.prompt.md` Step 3): distinguish two shapes of
command-criterion - one where the command-criterion is the *only*
evidence for a specific behavior (still judged from the code/tests it's
checking, UNKNOWN if unconfirmable, unchanged), and one where it's a
blanket restatement layered on top of other already-judged criteria
("`cargo test` passes with tests covering the above") - the latter is
marked PASS once everything it references is itself PASS, not retained
just because the model can't personally execute it.

Re-running after the fix surfaced a second, separate bug: the model now
correctly emits `(none - all criteria satisfied)` for sa502 - the
maximally correct answer - but `grade_sa502_already_implemented`
(`bench_block.py`) was written when this fixture was only ever exercised
through `plan` (which always lists every criterion, never an empty
result) and FAILs anything that doesn't mention the target file by name.
An empty gap-plan never mentions anything, by construction. Fixed the
grader to check for `"(none - all criteria satisfied)"` before the
mentions-target gate.

**Both fixes together**: sa502 went from 0/3 + 0/3 to **3/3
(`gpt-5.4-mini`) and 2/3 (`claude-haiku-4-5`)** at the same trial count -
the one remaining `claude-haiku-4-5` loss was a genuine sa452 file-split
trap-miss on re-verification (not this fixture, not a flake pattern), in
line with that model's existing higher variance on this benchmark.
Re-ran sa452/sa500/sa501 after both fixes to confirm no regression:
sa500 and sa501 stayed 3/3 for both models; sa452 stayed 3/3 for
`gpt-5.4-mini` (the actual pipeline default) and dropped to 2/3 for
`claude-haiku-4-5` on one isolated trap-miss, not a repeated pattern.

**Updated recommendation**: with both fixes in place, `gpt-5.4-mini`
goes 3/3 on every fixture (sa452/sa500/sa501/sa502) at n=3. Still short of
the ~10-25 trials this file's own guidance says to trust before changing
a default, but the original blocking regression is resolved with a real
root cause identified, not just patched around - worth a larger trial
batch next before swapping `check-ticket.py`/`resolve-ticket.py` over
(task tracked separately).

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
