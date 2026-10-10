# OpenCode configuration

Imported from the standalone local OpenCode repository. The implementation/planning agents and five skills remain.
Review-only subagents are replaced by review-cli.

## Install

From the dotfiles root, choose the installer appropriate for your machine:

```powershell
.\install\windows-full.ps1 -Machine home
.\install\windows-restricted.ps1 -Machine work
```

The full installer uses junctions for agents, skills, scripts and tools, and symbolic
links for opencode.jsonc and dcp.jsonc. File symlinks require Windows Developer
Mode or administrator rights, like the other full-installer dotfiles. The
restricted installer copies the same files without requiring link privileges.
Only these managed entries are deployed; unrelated files, logs and credentials
in the config directory are left in place.

For OpenCode alone (PowerShell 7+):

```powershell
.\opencode\setup.ps1
.\opencode\setup.ps1 -Copy
.\opencode\setup.ps1 -WhatIf
```

If old configuration is present, installation skips OpenCode until you supply
`-Force`. Forced replacements, including the old opencode.json, are moved to a
unique folder under ~/.config/opencode/backups/. Existing links are moved rather
than deleted recursively. The rest of each full dotfiles install still runs.
`-ConfigDir <path>` on setup.ps1 or install/opencode.ps1 supports custom locations.
Re-run copy installs with -Force to update changed copies. Link installs pick up
source edits; restart OpenCode after updating configuration.

The uploaded opencode.json contains comments, so it is named opencode.jsonc.
The redundant relative skills.paths setting was removed: skills are discovered
from the installed skills directory. No actual secret values are included.

## Dependencies and optional helpers

- Install/authenticate OpenCode and the model providers you use.
- Node/npm/npx are required by the configured MCP servers and plugin setup.
- Configure ~/.secrets/linear-key and ~/.secrets/stripe-key for the enabled MCPs.
- Ollama uses localhost:11434.

Run helpers from ~/.config/opencode/scripts/ so latch state and agent files refer
to the same installation. latch.example.json seeds local latch.json once; installer
reruns preserve its state. In link mode, model toggles and pipeline escalation edit
tracked agent files. In copy mode they edit installed copies.

```powershell
& "$env:USERPROFILE\.config\opencode\scripts\toggle-github-latch.ps1" -Status
```

AGENTS.md is maintenance guidance for this directory and is not deployed as global
OpenCode instructions. scratch-notes/ is retained in Git but not installed. The former standalone .git directory is not imported.

## Implementation models

Implementer defaults to `opencode/gpt-6-luna` through OpenCode Zen. The pipeline
runner uses the same model for startup recovery and resets after escalation.
Its Tier 2 and model-error fallback are `opencode/gpt-6.1-sol`; the existing
three Tier 1 / two Tier 2 invocation limits and global retry budget still apply.
Both models require access through the Zen account connected in OpenCode.
The legacy Copilot latch does not swap these models. Review-cli model selection
remains independent via `REVIEW_MODEL` or a tool argument.

## Collaborative Design → deterministic execution → independent review

The `design` primary agent is the **only author of executor input**, including
all corrections. It investigates the repository, discusses consequential decisions
(particularly algorithms and data structures), obtains design approval, and loads
the reusable `executor` skill to prepare complete JSON operations.

**Design approval is not execution approval.** Design presents the initial
operations and requests explicit permission to execute. It captures a fixed
Git baseline and checks for pre-existing changes. The approved requirements
remain the review contract across corrections; consequential changes to agreed
decisions require renewed user approval.

Once execution is approved, Design calls the single `execute_and_review`
OpenCode tool. This is **deterministic code, not an AI subagent**. Each invocation:

1. Verifies the original 40-character baseline SHA still matches HEAD.
2. Applies the exact Design-authored JSON through the existing executor adapter
   (`executor apply -` using stdin; no shell or repository-local scratch file).
3. Runs the explicit build command, then the explicit test command, using
   executable/argument arrays (not shell command strings).
4. Requires evidence that at least one test executed, and checks that build/tests
   did not change tracked or non-ignored working-tree files.
5. Only on success, invokes the existing review-cli adapter using the same
   original baseline and approved requirements.

The tool returns `PASSED`, `NEEDS_DESIGN` (executor conflict, build/test
failure or blocking review finding), or `BLOCKED` (missing tool, inconclusive
test/review, unexpected source change or environment failure). It **never retries
or generates repairs**. On a partial executor failure, earlier changes may
remain and Design must inspect the worktree before generating new operations.

The same Design conversation owns retries (up to five application attempts),
diagnoses failures and produces every correction against the current working
tree. Corrections within the approved architecture can proceed autonomously;
design changes require user discussion and approval. Neither an Execution Loop nor a Review Phase AI agent is needed. Standalone
semantic reviews remain available through the `review_changes` tool.

### Tool invocation

```json
{
  "input": "{\\"operations\\":[...]}",
  "requirements": "Approved design and acceptance criteria",
  "baseRef": "original 40-character Git commit SHA",
  "buildCommand": ["cargo", "build"],
  "testCommand": ["cargo", "test"],
  "reviewModel": "opencode/gpt-6.1-sol"
}
```

The `input` field must contain the actual complete executor JSON, not the
illustrative ellipsis above. The command arrays are passed directly to the OS,
without shell expansion or command chaining. If a toolchain command needs shell
syntax, provide an explicit script executable. `toolchain-detection` may help
identify commands but does not automatically parse arbitrary shell strings.
For unrecognized test-runner summaries, `testEvidencePattern` accepts a regex
whose first capture group is the **number of executed tests**.

The default review model is GPT-6.1 Sol, independent from Claude Sonnet Design;
review-cli performs the only additional model call. Install `executor` and
`review-cli` separately and make them available on OpenCode's PATH (or use
`EXECUTOR_BIN` and `REVIEW_CLI_BIN`). Restart OpenCode after updating
configuration or environment variables.

The legacy `pipeline-runner` remains available for other workflows but is not
used by Design. On forced reinstall, stale `review-phase.md`,
`execution-loop.md` and `apply_executor.ts` are backed up and removed.

Run the deterministic adapter tests from the repository root:

```powershell
node --test tests/executor-runner.test.mjs tests/execute-and-review.test.mjs
pwsh -NoProfile -File tests/install-opencode.ps1
```

## Review integration

`review_changes` is a global OpenCode tool backed by a shell-free Node subprocess
adapter. It consolidates code review, security inspection, reuse checking and
structural recommendations. The pipeline runner performs mechanical commands and
maps every acceptance criterion to evidence before requesting binary review.
Five retired agent files are backed up and removed during forced installation,
including on copy-based machines. Re-run your installer with -Force after pulling.

Install the binary separately on each machine (Rust/Cargo required for installation):

```powershell
cargo install --git https://github.com/jared-two-foxes/review --locked review-cli
review-cli --help
```

Git is required by the adapter. OpenCode provides the JS runtime and tool helper.
The binary must be on the OpenCode process PATH, or set REVIEW_CLI_BIN to its full
executable path. Restart OpenCode after changing environment variables.

The review model is independent of the orchestrator and implementer models. Set
REVIEW_MODEL (default opencode/claude-sonnet-5) or supply an explicit tool model.
Use a review-cli build with Anthropic Messages support for Claude on Zen.
Reinstall the binary with the cargo install command above and `--force` to update
an existing installation. Claude Sonnet 5 provides a different model family from
the GPT Implementer. Existing REVIEW_MODEL values override this default; unset
old GPT overrides or set REVIEW_MODEL=opencode/claude-sonnet-5.
For the default provider, export OPENCODE_API_KEY; openai/<model> uses OPENAI_API_KEY,
ollama/<model> uses the local Ollama endpoint, and copilot/<model> uses credentials
supported by review-cli. OpenCode's stored login is not automatically forwarded.
Do not commit provider credentials.

The legacy pipeline-runner requires a clean starting worktree; the new Design
workflow instead checks pre-existing changes and asks the user to isolate
unrelated edits or accept their inclusion in the review diff. Both retain the
original commit SHA through all retries. The review tool compares that base
against the current working tree,
including new untracked files. Review-only mode requires an explicit baseline and
can instead review a fixed committed target. The tool stores requirements/request
files outside the repository, removes them afterwards, validates result/exit-code
consistency, and rejects results if repository contents change during inspection.

For the new deterministic Design workflow, APPROVED plus passing build and tests
completes the attempt. CHANGES_REQUESTED returns blocking findings to Design;
INDETERMINATE and ERROR block without approval. The tool never retries or
invokes an implementer. The legacy pipeline-runner retains its own older retry
and model escalation policy. Standalone review-only never applies findings or
claims that tests were run.

Current binary limitations: it inspects code with read-only tools, not test/build
execution; criterion coverage in its result is not a typed evidence matrix. That
matrix stays with the runner. Its general review prompt still asks for a concrete
finding, and its specialized test-quality skill currently targets Python files.
The adapter preserves the binary's verdict and does not pretend these limitations
are additional verified guarantees.

Run integration checks from the dotfiles root:

```powershell
node --test tests/review-runner.test.mjs
pwsh -NoProfile -File tests/install-opencode.ps1
```

The subprocess tests use a protocol fixture; they do not spend provider credits or
measure live model review quality.

## Removing the former daily summary

The daily-summary agent and its scheduling helpers are retired. Forced installer
upgrades back up and remove their old installed copies. If you previously
registered the Windows task, remove that registration once on that machine:

```powershell
Unregister-ScheduledTask -TaskName 'OpenCode Daily Summary' -Confirm:$false
```

Existing summary logs are retained.
