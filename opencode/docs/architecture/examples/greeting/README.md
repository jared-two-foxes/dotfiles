# Fictional greeting workflow

The workflow workspace root is this directory. All manifest artefact references
are relative to it (including those in r2/). There are no actual approval receipts;
these documents are fixtures, not authorization to execute a real task.

- base/greeting.py is the entire initial tree. Initialize a SHA-1 repository,
  core.autocrlf=false, with this file as greeting.py, mode 100644. Use author and
  committer `Workflow Example <workflow@example.invalid>`, both timestamps
  `2026-01-01T00:00:00Z`, and message `Example base` to reproduce the base SHA.
- design.md, execution-manifest.json and change.patch form immutable revision 1.
  expected/ is the resulting tree for fixture comparison only; it is not an
  alternative full-file execution format.
- execution-success.json publishes a candidate for review. Its reproducible
  commit has the manifest identity/time/message and one parent (the base).
- execution-failed.json demonstrates a separate environmental attempt of the
  same approved plan: candidate exists but ref publication failed. Pause and
  reconcile before retrying; never Review the unpublished result.
- execution-invalid.json is a counterfactual corrupt-patch attempt. The validated
  original patch is not defective. This failure returns PATCH_NOT_APPLICABLE to
  Design without creating a worktree. It demonstrates plan-invalid routing.
- review-result.json requests changes even though both unit tests passed: the
  required tab/newline assertions are missing. semantic-raw.json is illustrative
  review-cli-compatible output, not a live AI review. unit.log is actual fixture
  test output. source_snapshot uses SHA-256 over sorted source paths, each UTF-8
  path followed by NUL then its bytes; the production snapshot algorithm remains
  a Review adapter concern.
- revised-design.md, r2/execution-manifest.json and r2/change.patch demonstrate a
  new proposal with tab/newline coverage, linked to the feedback. It is again a
  single combined patch from the original base. New design/patch checksums and
  plan/design revisions invalidate revision 1 approval; the human must approve
  revision 2. No execution/review results are claimed for this revised proposal.

The validation suite recreates the exact base and candidate in temporary Git
repositories, validates both patches and asserts their behaviour. It does not
implement the proposed executor or create worktrees in a user's project.
