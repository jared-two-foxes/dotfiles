# Pi standalone review

This native extension registers `review_changes`, independently of Conductor.
Use `/skill:review` in Research mode to review existing commits, local PR refs,
or working-tree changes. It neither applies fixes nor runs builds or tests.
Implementation still uses Design and `execute_and_review`; standalone approval
is not evidence of passing tests and cannot replace Conductor verification.

## Native installation

Place the entire `review` directory (including all `.mjs` files and
`package.json`) in `~/.pi/agent/extensions/review/`. No OpenCode installation
is required. If the active agent home is this checkout, no copy is needed.
Reload Pi or restart it after deployment. Also deploy the updated `SYSTEM.md`,
`AGENTS.md` and review skill to a copy-based agent installation.

Install the standalone binary separately:

```sh
cargo install --git https://github.com/jared-two-foxes/review --locked review-cli
```

The binary must be on Pi's PATH, or set `REVIEW_CLI_BIN` to its executable path.
Use a current binary supporting the optional limit flags. Provider credentials
are inherited from the environment; an absent `OPENCODE_API_KEY` falls back to
`~/.secrets/opencode-key`, without changing the parent process environment.
Credentials and temporary request contents are not returned in tool results.
Docker mounting and binary provisioning are not included in this integration.

## Requests

```json
{
  "baseRef": "HEAD~1",
  "headRef": "HEAD",
  "requirements": "Review correctness, security and regressions in the last commit."
}
```

Omit `headRef` (or use `:working`) for uncommitted changes, including non-ignored
untracked files. `repository` defaults to the session repository. Both commit
refs are resolved to fixed SHAs; `:staged` and `:empty` are not exposed here.
For PR-style changes use an explicit merge-base SHA as `baseRef` and an already
available local PR/branch ref as `headRef`. The tool does not fetch, checkout,
stage, commit, push or publish a review.

`model` overrides `REVIEW_MODEL`, then defaults to `opencode/gpt-6.1-sol`.
Defaults are 180 seconds and 20 turns; `wallClockBudgetSecs` (1-600) and
`maxTurns` (1-100) override them. Optional `maxCostUsd` (finite, nonnegative),
`maxToolCalls` (1-10000), `maxRepeatedActions` (1-100) and
`maxCompletionAttempts` (1-100) are forwarded only when supplied. Omitted
optional limits retain the review engine defaults; there is no automatic retry.

## Safety and results

The adapter uses shell-free subprocesses, a deadline and a 4 MiB output cap.
Request files are created outside the repository and removed on success or
failure. It validates verdict/exit-code agreement and finding shapes, and checks
HEAD, staged/working changes and non-ignored untracked contents before and after
all reviews, even committed-target reviews. It does not provide an OS sandbox,
monitor ignored files, or detect transient changes restored before the final check.

`APPROVED` and `CHANGES_REQUESTED` require `REVIEW_COMPLETED`; blocking findings
and suggestions remain separate. `INDETERMINATE` and `ERROR` never approve a
change. Missing tools, invalid results, cancellation, timeout, excessive output,
repository changes and cleanup failures are surfaced without applying fixes.
Tests use a fake reviewer and require no provider credentials or model calls.
