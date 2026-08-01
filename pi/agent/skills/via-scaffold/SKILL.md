---
name: via-scaffold
description: Orchestrate source changes across repos using the scaffold_run tool. Use when a task requires editing source code — the agent is read-only except via scaffold_run. For changes that span repos, orchestrate the order yourself by calling scaffold_run per repo in dependency order (one repo per call; it does not detect cross-repo impact).
---

# via-scaffold

The only sanctioned way to mutate source. The agent runs read-only: do
not use edit/write on source files. Source authoring goes through the
`scaffold_run` tool only. Running tests, builds, and contract-sync commands
(e.g. `npm run generate:api`) directly via bash is fine — those are build
steps, not source authoring.

> This skill orchestrates one repo per scaffold_run call. It does NOT
detect that a change in repo A broke repo B. If a change touches a
shared contract or a repo others depend on, you must run the dependent
repos' tests yourself and report.

## Prerequisites

- `scaffold` on PATH.
- Each target repo may have a `.dev-pipeline.toml` (set `git_workflow = true`
  for branches/PRs). It's optional; defaults apply if absent.
- **Caveat — scaffold re-fetches the ticket by id at its final
  `TICKET_VALIDATE` step.** Pass a real Linear ticket id as `work_id` if you
  want validate to pass; a synthetic slug completes the TDD work (red→green)
but the final validate re-fetch fails. For a change with no Linear ticket,
  create a throwaway one first and use its id.

## How to orchestrate a change

1. **Decompose the change yourself per repo.** You have cross-repo
   visibility — decide which repos change and in what order. If repo B
   consumes an API that repo A produces, run A first.
2. **For each repo, in dependency order:**
   a. Compose a spec (see format below).
   b. Call the `scaffold_run` tool with `repo_path`, `work_id`, and `spec`.
   c. Read the structured result:
      - `status: "done"` → all criteria passed, move on.
      - `status: "paused"` → a human decision is needed in-repo. Read
        `stackTopFrame.status` and `lastLog` to determine what input is
        needed; report it, do not blindly retry.
      - `status: "failed"` → a real error. Read `stderr` and `lastLog`
        for the error and report.
      - `status: "declined"` → scaffold's grounding check rejected a
        criterion (`declinedCriteria` is non-null). The spec wording needs
        adjusting, not a retry.
3. **Between a producer and its consumers**, if the consumer regenerates a
   client from a contract (e.g. OpenAPI), run the producer's export and the
   consumer's generator via bash *before* scaffold_run in the consumer
   (build step, not source authoring).
4. **Report per-repo outcomes** when done.

## Spec format

```
# <short title>

<optional prose — what + why>

## Acceptance Criteria
- [ ] <criterion 1>
- [ ] <criterion 2>
```

Each criterion must be independently testable. One spec per repo per change.

## What this does NOT do

- No cross-repo impact detection. Run dependent repos' tests manually
  when a change crosses a seam.
- No persistent plan across sessions — the orchestration lives in your
  context for this chat only.
